import { describe, it, expect } from "vitest";
import { ProviderGateway } from "../src/gateway/gateway.js";
import { BudgetCounter } from "../src/runtime/budget.js";
import { DEFAULT_BUDGET, type RunEvent } from "../src/graph/schema.js";
import { ProviderCircuits } from "../src/gateway/circuits.js";
import { ConnectionLimits } from "../src/gateway/limits.js";
import { aggregateUsage, wilsonLower } from "../src/gateway/metrics.js";
import { retryAfterMs } from "../src/providers/errors.js";
import { adaptProvider } from "../src/providers/conformance.js";
import type {
  AgentResult,
  ProjectConfig,
  ProviderAdapter,
  RouteEntry,
} from "../src/types.js";
const route: RouteEntry = {
  connectionId: "mock",
  provider: "mock",
  modelId: "one",
  displayName: "Mock",
  reasoningEffort: "high",
  score: 100,
  source: "override",
};
const request = {
  runId: "run",
  nodeId: "work",
  role: "worker" as const,
  projectRoot: process.cwd(),
  prompt: "Do bounded work",
};
function setup(results: AgentResult[], auth = "authenticated") {
  const config = { connections: [] } as unknown as ProjectConfig;
  const events: RunEvent[] = [];
  const budget = new BudgetCounter(DEFAULT_BUDGET);
  const gateway = new ProviderGateway(
    config,
    budget,
    async (e) => {
      events.push(e);
    },
    0,
  );
  let calls = 0;
  const adapter: ProviderAdapter = {
    id: "mock",
    mode: "process",
    async detect() {
      return { installed: true, version: "test" };
    },
    async listModels() {
      return [];
    },
    async authStatus() {
      return { status: auth as "authenticated", method: "process" };
    },
    async invoke() {
      return results[Math.min(calls++, results.length - 1)]!;
    },
  };
  gateway.adapters.set("mock", adapter);
  return { gateway, events, budget, adapter, calls: () => calls };
}
describe("provider gateway", () => {
  it("retries transient failures and records distinct attempts", async () => {
    const f = setup([
      {
        text: "",
        exitCode: 429,
        error: {
          kind: "rate_limit",
          retryable: true,
          message: "limited",
          retryAfterMs: 0,
        },
      },
      { text: "ok", exitCode: 0 },
    ]);
    const result = await f.gateway.invoke(
      [route],
      request,
      new AbortController().signal,
    );
    expect(result.result.text).toBe("ok");
    expect(f.calls()).toBe(2);
    expect(
      f.events.filter((e) => e.type === "invocation.started"),
    ).toHaveLength(2);
  });
  it("does not rotate away from a hard pin", async () => {
    const f = setup([
      {
        text: "",
        exitCode: 1,
        error: { kind: "server_error", retryable: true, message: "offline" },
      },
    ]);
    await expect(
      f.gateway.invoke(
        [route, { ...route, modelId: "two" }],
        request,
        new AbortController().signal,
        undefined,
        true,
      ),
    ).rejects.toThrow(/offline/);
    expect(f.calls()).toBe(2);
    expect(f.events.some((e) => e.type === "circuit.changed")).toBe(true);
  });
  it("stops on authentication, permanent errors and exhausted global budget", async () => {
    const auth = setup([{ text: "ok", exitCode: 0 }], "unauthenticated");
    await expect(
      auth.gateway.invoke([route], request, new AbortController().signal),
    ).rejects.toThrow(/Authentication/);
    expect(auth.calls()).toBe(0);
    const denied = setup([
      {
        text: "",
        exitCode: 1,
        error: { kind: "policy_denial", retryable: false, message: "denied" },
      },
    ]);
    await expect(
      denied.gateway.invoke([route], request, new AbortController().signal),
    ).rejects.toThrow(/denied/);
    expect(denied.calls()).toBe(1);
    const exhausted = setup([{ text: "ok", exitCode: 0 }]);
    exhausted.budget.attempts = 256;
    await expect(
      exhausted.gateway.invoke([route], request, new AbortController().signal),
    ).rejects.toThrow(/budget/);
  });
  it("repairs invalid outputs without accepting empty success", async () => {
    const f = setup([
      { text: "wrong", exitCode: 0 },
      { text: '{"ok":true}', exitCode: 0 },
    ]);
    const r = await f.gateway.invoke(
      [route],
      request,
      new AbortController().signal,
      (text) => JSON.parse(text),
    );
    expect(JSON.parse(r.result.text)).toEqual({ ok: true });
    const empty = setup([{ text: "", exitCode: 0 }]);
    await expect(
      empty.gateway.invoke([route], request, new AbortController().signal),
    ).rejects.toThrow(/Empty/);
  });
  it("rejects delays beyond the active budget and unavailable routes", async () => {
    const f = setup([
      {
        text: "",
        exitCode: 429,
        error: {
          kind: "rate_limit",
          retryable: true,
          message: "wait",
          retryAfterMs: 8_000_000,
        },
      },
    ]);
    await expect(
      f.gateway.invoke([route], request, new AbortController().signal),
    ).rejects.toThrow(/remaining budget/);
    await expect(
      f.gateway.invoke(
        [{ ...route, connectionId: "absent" }],
        request,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/available/);
  });
  it("normalizes the adapter without claiming live verification", async () => {
    const f = setup([{ text: "ok", exitCode: 0 }]);
    const adapter = adaptProvider(
      {
        id: "mock",
        provider: "mock",
        adapter: "generic-process",
        enabled: true,
        mode: "process",
      },
      f.adapter,
    );
    expect(adapter.describe().connectionId).toBe("mock");
    expect((await adapter.probe()).support).toBe("compatible");
    expect(await adapter.listModels()).toEqual([]);
    const events = [];
    for await (const e of adapter.invoke(
      {
        ...request,
        invocationId: "logical",
        attemptId: "attempt",
        generation: 0,
        workspaceRoot: request.projectRoot,
        context: { prompt: request.prompt },
        permissions: { readPaths: ["**"], writePaths: [] },
        deadlineAt: new Date(Date.now() + 60000).toISOString(),
        model: { ...route, mode: "process" },
      },
      new AbortController().signal,
    ))
      events.push(e);
    expect(events[0]?.type).toBe("result");
  });
});
describe("limits and measurement", () => {
  it("allows a bounded recovery probe after a circuit cools", () => {
    const c = new ProviderCircuits();
    c.restore("x", 10);
    expect(c.available("x", 9)).toBe(false);
    expect(c.available("x", 10)).toBe(true);
    c.claim("x");
    expect(c.available("x", 100)).toBe(false);
    c.success("x");
    expect(c.available("x", 100)).toBe(true);
    expect(c.trip("x", 0)).toBeLessThanOrEqual(Date.now());
  });
  it("serializes a connection and removes cancelled waiters", async () => {
    const limits = new ConnectionLimits(1);
    let release!: () => void;
    const first = limits.use(
      "x",
      new AbortController().signal,
      () => new Promise<void>((r) => (release = r)),
    );
    const controller = new AbortController();
    const waiting = limits.use("x", controller.signal, async () => 42);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    release();
    await first;
    expect(
      await limits.use("x", new AbortController().signal, async () => 7),
    ).toBe(7);
  });
  it("parses retry headers and separates absent usage from zero", () => {
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 0)).toBe(10_000);
    expect(retryAfterMs("nope")).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(20, 20)).toBeGreaterThan(0.8);
    const event = {
      type: "invocation.finished",
      payload: {
        attemptId: "one",
        nodeId: "work",
        connectionId: "mock",
        modelId: "one",
        durationMs: 5,
      },
    } as any;
    const rows = aggregateUsage([event, event]);
    expect(rows[0]?.calls).toBe(1);
    expect(rows[0]?.usageStatus).toBe("unknown");
  });
});

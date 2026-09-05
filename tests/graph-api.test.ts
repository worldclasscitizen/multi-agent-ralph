import { it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/workspace/manager.js";
import { saveConfig } from "../src/state.js";
import { planRun } from "../src/nodes/planner.js";
import { validateContract } from "../src/contracts.js";
import { startDashboard } from "../src/dashboard.js";
import { submitCommand, pendingCommands } from "../src/runtime/commands.js";
import { storeFor } from "../src/runtime/supervisor.js";
import { migrateGraphState } from "../src/migration/graph.js";
import { DEFAULT_BUDGET } from "../src/graph/schema.js";
import type { ProjectConfig } from "../src/types.js";
it("provides graph snapshots, cursor streams and protected commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-api-"));
  await git(root, ["init"]);
  const config = {
    schemaVersion: 1,
    projectRoot: root,
    preset: "balanced",
    initializedAt: new Date().toISOString(),
    connections: [],
    routes: {},
    overrides: {},
    verifierCommands: [],
    catalogVersion: 1,
  } as unknown as ProjectConfig;
  await saveConfig(root, config);
  const contract = validateContract(
    {
      taskType: "planning_architecture",
      goal: "Explain",
      acceptanceCriteria: ["Explain"],
    },
    root,
  );
  const plan = await planRun(root, "Explain", { contract, mode: "answer" });
  const store = await storeFor(root, plan.runId);
  const dashboard = await startDashboard(root, { port: 0 });
  try {
    const api = (path: string, init?: RequestInit) =>
      fetch(`${dashboard.url}api/v2/${path}`, init);
    expect(
      ((await api("runs").then((r) => r.json())) as any).runs[0].runId,
    ).toBe(plan.runId);
    expect(
      ((await api(`runs/${plan.runId}/graph`).then((r) => r.json())) as any)
        .nodes[0].kind,
    ).toBe("read");
    expect(
      (
        await api("session", {
          headers: { Origin: "https://untrusted.invalid" },
        })
      ).status,
    ).toBe(403);
    const command = {
      commandId: "test-command",
      expectedRevision: 1,
      type: "stop" as const,
    };
    expect(
      (
        await api(`runs/${plan.runId}/commands`, {
          method: "POST",
          body: JSON.stringify(command),
        })
      ).status,
    ).toBe(403);
    const { controlToken } = (await api("session").then((r) =>
      r.json(),
    )) as any;
    expect(
      (
        await api(`runs/${plan.runId}/commands`, {
          method: "POST",
          headers: { "X-Ralph-Token": controlToken },
          body: JSON.stringify(command),
        })
      ).status,
    ).toBe(202);
    await submitCommand(store, command);
    expect(await pendingCommands(store)).toHaveLength(1);
    await expect(
      submitCommand(store, { ...command, type: "cancel" }),
    ).rejects.toThrow(/reused/);
    const controller = new AbortController();
    const response = await api(`runs/${plan.runId}/events?after=1`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toContain("id: 2");
    controller.abort();
    await reader.cancel().catch(() => {});
    expect(await api("metrics").then((r) => r.json())).toEqual([]);
    expect(await api("providers").then((r) => r.json())).toEqual([]);
    expect((await api(`runs/${plan.runId}/artifacts/invalid`)).status).toBe(
      400,
    );
    const dry = await migrateGraphState(root, true),
      written = await migrateGraphState(root, false),
      again = await migrateGraphState(root, false);
    expect(dry.id).toBe(written.id);
    expect(again.id).toBe(written.id);
    expect(written.sourceDeleted).toBe(false);
  } finally {
    dashboard.server.closeAllConnections();
    await new Promise<void>((r) => dashboard.server.close(() => r()));
  }
}, 15000);

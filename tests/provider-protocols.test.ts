import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapter } from "../src/providers/index.js";
import { classifyProviderError } from "../src/providers/errors.js";
import { ProviderGateway } from "../src/gateway/gateway.js";
import { BudgetCounter } from "../src/runtime/budget.js";
import { DEFAULT_BUDGET } from "../src/graph/schema.js";
import { routesFor } from "../src/gateway/routing.js";
import type {
  AgentRequest,
  ConnectionConfig,
  ProjectConfig,
  RouteEntry,
  TaskContract,
} from "../src/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const variants = [
  {
    adapter: "openai-api",
    body: {
      model: "model",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: '{"ok":true}' }],
        },
      ],
    },
  },
  {
    adapter: "anthropic-api",
    body: { model: "model", content: [{ type: "text", text: '{"ok":true}' }] },
  },
  {
    adapter: "gemini-api",
    body: { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] },
  },
  {
    adapter: "deepseek-api",
    body: {
      model: "model",
      choices: [{ message: { content: '{"ok":true}' } }],
    },
  },
  {
    adapter: "zai-general-api",
    body: {
      model: "model",
      choices: [{ message: { content: '{"ok":true}' } }],
    },
  },
];
const connection = (adapter: string): ConnectionConfig => ({
  id: `fixture:${adapter}`,
  adapter,
  provider: adapter,
  enabled: true,
  mode: "api",
  baseUrl: "https://fixture.invalid",
  apiKeyEnv: "RALPH_PROTOCOL_FIXTURE_KEY",
});
const config = {
  connections: [],
  verifierCommands: [],
} as unknown as ProjectConfig;
const request: AgentRequest = {
  runId: "test",
  nodeId: "test",
  role: "critic",
  projectRoot: process.cwd(),
  prompt: "Return required JSON",
  model: {
    connectionId: "fixture",
    provider: "fixture",
    modelId: "model",
    displayName: "model",
    mode: "api",
  },
};
describe("API transport conformance with recorded protocol shapes", () => {
  it.each(variants)(
    "normalizes $adapter text without inventing usage",
    async ({ adapter, body }) => {
      vi.stubEnv("RALPH_PROTOCOL_FIXTURE_KEY", "fixture-value");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(body)),
      );
      const transport = createAdapter(connection(adapter), config);
      expect((await transport.detect()).installed).toBe(true);
      expect((await transport.authStatus()).status).toBe("authenticated");
      const r = await transport.invoke(request, new AbortController().signal);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.text)).toEqual({ ok: true });
      expect(r.usage).toBeUndefined();
    },
  );
  it.each(variants)(
    "normalizes $adapter rate limits and retry headers",
    async ({ adapter }) => {
      vi.stubEnv("RALPH_PROTOCOL_FIXTURE_KEY", "fixture-value");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(
            { error: { message: "Too many requests" } },
            { status: 429, headers: { "retry-after": "3" } },
          ),
        ),
      );
      const r = await createAdapter(connection(adapter), config).invoke(
        request,
        new AbortController().signal,
      );
      expect(r.error?.kind).toBe("rate_limit");
      expect(r.error?.retryable).toBe(true);
      expect(r.error?.retryAfterMs).toBe(3000);
    },
  );
  it("runs a compatible API worker's bounded file tools and preserves unknown aggregate usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-api-tools-"));
    vi.stubEnv("RALPH_PROTOCOL_FIXTURE_KEY", "fixture-value");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "write",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: "allowed.txt",
                        content: "ok",
                        expectedSha256: null,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { content: "Done" } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const r = await createAdapter(connection("deepseek-api"), config).invoke(
      {
        ...request,
        role: "worker",
        projectRoot: root,
        writePaths: ["allowed.txt"],
        readPaths: ["allowed.txt"],
      },
      new AbortController().signal,
    );
    expect(r.exitCode).toBe(0);
    expect(await readFile(join(root, "allowed.txt"), "utf8")).toBe("ok");
    expect(r.usage).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("builds every role from just DeepSeek and GLM and recovers a failed candidate", async () => {
    vi.stubEnv("RALPH_PROTOCOL_FIXTURE_KEY", "fixture-value");
    const connections = [
      connection("deepseek-api"),
      connection("zai-general-api"),
    ];
    const routes = connections.map((c) => ({
      connectionId: c.id,
      provider: c.provider,
      modelId: "model",
      displayName: "model",
      reasoningEffort: "high",
      score: 80,
      qualityScore: 80,
      source: "override",
    })) as RouteEntry[];
    const cfg = {
      ...config,
      connections,
      routes: Object.fromEntries(
        [
          "backend_core",
          "worker",
          "critic",
          "contractPlanner",
          "adjudicator",
        ].map((k) => [k, routes]),
      ),
    } as unknown as ProjectConfig;
    const contract = {
      taskType: "backend_core",
      executionProfile: "balanced",
    } as TaskContract;
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempts++;
        return attempts <= 2
          ? Response.json(
              { error: { message: "temporarily unavailable" } },
              { status: 503 },
            )
          : Response.json({
              choices: [{ message: { content: '{"ok":true}' } }],
            });
      }),
    );
    const gateway = new ProviderGateway(
      cfg,
      new BudgetCounter(DEFAULT_BUDGET),
      async () => {},
      0,
    );
    for (const role of [
      "contractPlanner",
      "worker",
      "critic",
      "adjudicator",
    ] as const) {
      const selected = routesFor(cfg, contract, role);
      expect(
        selected.routes.every((r) =>
          connections.some((c) => c.id === r.connectionId),
        ),
      ).toBe(true);
      const r = await gateway.invoke(
        selected.routes,
        { ...request, role },
        new AbortController().signal,
      );
      expect(r.result.exitCode).toBe(0);
    }
  });
  it("classifies expired CLI OAuth credentials as permanent authentication failure", () => {
    const error = classifyProviderError({
      message:
        "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
    });
    expect(error.kind).toBe("authentication");
    expect(error.retryable).toBe(false);
  });
});

it("gives API planners read-only evidence tools and refuses unadvertised writes", async () => {
  const { writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "ralph-read-tools-"));
  await writeFile(join(root, "fact.txt"), "Verified repository fact");
  vi.stubEnv("RALPH_PROTOCOL_FIXTURE_KEY", "fixture-value");
  let turn = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      expect(body.tools.map((t: any) => t.function.name)).toContain(
        "read_file",
      );
      expect(body.tools.map((t: any) => t.function.name)).not.toContain(
        "write_file",
      );
      expect(body.tools.map((t: any) => t.function.name)).not.toContain(
        "run_verifier",
      );
      turn++;
      if (turn === 1)
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "read",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({ path: "fact.txt" }),
                    },
                  },
                ],
              },
            },
          ],
        });
      if (turn === 2) {
        expect(body.messages.at(-1).content).toContain(
          "Verified repository fact",
        );
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "write",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: "outside.txt",
                        content: "unauthorized",
                        expectedSha256: null,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      expect(body.messages.at(-1).content).toContain(
        "outside approved node scope",
      );
      return Response.json({
        choices: [{ message: { content: "Repository evidence inspected" } }],
      });
    }),
  );
  const adapter = createAdapter(connection("deepseek-api"), config);
  const result = await adapter.invoke(
    {
      ...request,
      role: "contractPlanner",
      projectRoot: root,
      readPaths: ["fact.txt"],
    },
    new AbortController().signal,
  );
  expect(result.exitCode).toBe(0);
  expect(turn).toBe(3);
  await expect(readFile(join(root, "outside.txt"), "utf8")).rejects.toThrow();
});

it("excludes provider-private reasoning parts from Gemini output artifacts", async () => {
  vi.stubEnv("RALPH_PROTOCOL_FIXTURE_KEY", "fixture-value");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: "Internal private trace" },
                { text: "Public answer" },
              ],
            },
          },
        ],
      }),
    ),
  );
  const result = await createAdapter(connection("gemini-api"), config).invoke(
    request,
    new AbortController().signal,
  );
  expect(result.text).toBe("Public answer");
});

import { it, expect, vi } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WorkspaceManager,
  IntegrationConflict,
  git,
} from "../src/workspace/manager.js";
import { saveConfig } from "../src/state.js";
import { validateContract } from "../src/contracts.js";
import { planRun } from "../src/nodes/planner.js";
import { approvePlan } from "../src/interaction/approval.js";
import { startRun, resumeGraphRun } from "../src/runtime/supervisor.js";
import type { ProjectConfig, RouteEntry } from "../src/types.js";
import { singleGraph } from "../src/graph/compiler.js";
import { storeFor } from "../src/runtime/supervisor.js";
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ralph-graph-e2e-"));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "README.md"), "baseline\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "baseline"]);
  const route: RouteEntry = {
    connectionId: "mock:process",
    provider: "mock",
    modelId: "mock-1",
    displayName: "Mock",
    reasoningEffort: "high",
    score: 100,
    source: "override",
  };
  const routes = Object.fromEntries(
    [
      "planning_architecture",
      "frontend_visual",
      "backend_core",
      "tdd_debugging",
      "static_review",
      "delivery_evidence",
      "contractPlanner",
      "router",
      "critic",
      "metaPrompter",
      "worker",
      "adjudicator",
    ].map((key) => [key, [route]]),
  ) as ProjectConfig["routes"];
  const config: ProjectConfig = {
    schemaVersion: 1,
    projectRoot: root,
    preset: "balanced",
    initializedAt: new Date().toISOString(),
    connections: [
      {
        id: route.connectionId,
        adapter: "generic-process",
        provider: "mock",
        enabled: true,
        mode: "process",
        command: [process.execPath, resolve("tests/fixtures/mock-agent.mjs")],
      },
    ],
    routes,
    overrides: {},
    verifierCommands: [
      `node -e "require('node:fs').accessSync('ralph-smoke.txt')"`,
      "git diff --check",
    ],
    catalogVersion: 2,
  };
  await saveConfig(root, config);
  const contract = validateContract(
    {
      taskType: "backend_core",
      goal: "Create smoke artifact",
      include: ["ralph-smoke.txt"],
      exclude: [".git/**"],
      acceptanceCriteria: ["Artifact exists"],
      verifierCommands: config.verifierCommands,
      requiredArtifacts: ["ralph-smoke.txt"],
    },
    root,
  );
  return { root, config, contract };
}
it("executes the real graph loop in isolated workspaces and delivers once", async () => {
  const { root, contract } = await fixture();
  const plan = await planRun(root, contract.goal, { contract, mode: "single" });
  await expect(startRun(plan)).rejects.toThrow(/approve/);
  const state = await startRun(approvePlan(plan));
  expect(state.message).toBeUndefined();
  expect(state.status).toBe("completed");
  expect(
    (await readFile(join(root, "ralph-smoke.txt"), "utf8")).replaceAll(
      "\r\n",
      "\n",
    ),
  ).toBe("ok\n");
  const head = await git(root, ["rev-parse", "HEAD"]);
  expect((await resumeGraphRun(root, plan.runId)).status).toBe("completed");
  expect(await git(root, ["rev-parse", "HEAD"])).toBe(head);
}, 30000);

it.each(["validation", "merge"])(
  "executes fan-out and repairs %s failure while keeping original generations",
  async (failure) => {
    const { root, config } = await fixture();
    const checkLeft = `node -e "require('fs').accessSync('left.txt')"`;
    const checkRight = `node -e "require('fs').accessSync('right.txt')"`;
    const checkCombined = `node -e "if(require('fs').readFileSync('left.txt','utf8').trim()!=='ok')process.exit(1)"`;
    config.verifierCommands = [
      checkLeft,
      checkRight,
      checkCombined,
      "git diff --check",
    ];
    await saveConfig(root, config);
    const contract = validateContract(
      {
        taskType: "backend_core",
        goal: "Produce two independently verified artifacts and verify their integration",
        include: ["left.txt", "right.txt"],
        acceptanceCriteria: ["left and right contain ok"],
        verifierCommands: config.verifierCommands,
        requiredArtifacts: ["left.txt", "right.txt"],
      },
      root,
    );
    const task = {
      taskType: contract.taskType,
      goal: contract.goal,
      readPaths: ["**"],
      writePaths: ["left.txt"],
      acceptanceCriteria: ["left exists"],
      requiredCapabilities: [],
      inputArtifacts: [],
      verifierIds: [checkLeft],
      budget: { maxIterations: 6 },
    };
    const graph = singleGraph("proposed", task);
    graph.nodes[0]!.nodeId = "left";
    graph.edges[0]!.from = "left";
    graph.nodes.splice(1, 0, {
      ...graph.nodes[0]!,
      nodeId: "right",
      writePaths: ["right.txt"],
      acceptanceCriteria: ["right exists"],
      verifierIds: [checkRight],
    });
    graph.edges.push({ from: "right", to: "integrate", kind: "artifact" });
    const plan = await planRun(root, contract.goal, { contract, graph });
    const prepare = WorkspaceManager.prototype.prepare;
    let injected = false;
    const spy = vi
      .spyOn(WorkspaceManager.prototype, "prepare")
      .mockImplementation(async function (...args) {
        const input = await prepare.apply(this, args);
        if (failure === "merge" && args[0] === "integrate" && !injected) {
          injected = true;
          await writeFile(
            join(input.root, "left.txt"),
            "<<<<<<< ours\ninitial\n=======\nok\n>>>>>>> theirs\n",
          );
          const head = await this.checkpoint(input.root, "integrate", 0, 0);
          throw new IntegrationConflict({
            ...input,
            inputHead: head,
            conflictErrors: [
              {
                nodeId: "left",
                message: "Injected Git conflict boundary",
                patch: "preserved in source snapshot",
              },
            ],
          });
        }
        return input;
      });
    let result;
    try {
      result = await startRun(approvePlan(plan));
    } finally {
      spy.mockRestore();
    }
    expect(result.message).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(result.revision).toBe(2);
    expect(result.nodes.left?.generation).toBe(0);
    expect(result.nodes.right?.generation).toBe(0);
    expect(result.nodes.repair?.status).toBe("completed");
    expect(result.nodes.validate?.generation).toBe(1);
    expect((await readFile(join(root, "left.txt"), "utf8")).trim()).toBe("ok");
    const store = await storeFor(root, plan.runId),
      events = await store.readAfter();
    expect(
      events.filter(
        (e) =>
          e.type === "invocation.started" &&
          e.payload.nodeId === "left" &&
          e.payload.role === "worker",
      ),
    ).toHaveLength(1);
    expect(events.filter((e) => e.type === "graph.revised")).toHaveLength(2);
    expect((await resumeGraphRun(root, plan.runId)).resultHead).toBe(
      result.resultHead,
    );
  },
  30000,
);

it.each(["dirty", "head", "saved-plan"])(
  "blocks changed %s inputs after approval",
  async (change) => {
    const { root, contract } = await fixture();
    const plan = approvePlan(
      await planRun(root, contract.goal, { contract, mode: "single" }),
    );
    if (change === "saved-plan") {
      const store = await storeFor(root, plan.runId);
      await writeFile(
        join(store.directory, "plan.json"),
        JSON.stringify({ ...plan, baseBranch: "other" }),
      );
    } else {
      await writeFile(join(root, "user.txt"), "User data");
      if (change === "head") {
        await git(root, ["add", "."]);
        await git(root, ["commit", "-m", "User commit"]);
      }
    }
    const state = await startRun(plan);
    expect(state.status).not.toBe("completed");
    expect(state.attempts).toBe(0);
    expect(await git(root, ["worktree", "list", "--porcelain"])).not.toContain(
      "workspaces",
    );
  },
);
it("persists command results, pauses before dispatch and resumes the same read run", async () => {
  const { root, contract } = await fixture();
  const plan = approvePlan(
    await planRun(root, "Explain the project", { contract, mode: "answer" }),
  );
  const store = await storeFor(root, plan.runId);
  const { submitCommand } = await import("../src/runtime/commands.js");
  await submitCommand(store, {
    commandId: "stop-once",
    expectedRevision: 1,
    type: "stop",
  });
  const paused = await startRun(plan);
  expect(paused.status).toBe("paused");
  expect(paused.attempts).toBe(0);
  expect(paused.commands["stop-once"]).toEqual({ accepted: true });
  const result = await resumeGraphRun(root, plan.runId);
  expect(result.status).toBe("completed");
  expect(result.attempts).toBe(1);
  expect(Object.keys(result.nodes)).toEqual(["answer"]);
  const { watchRun } = await import("../src/runtime/supervisor.js");
  const events = [];
  for await (const e of watchRun(root, plan.runId, result.seq - 1))
    events.push(e);
  expect(events).toHaveLength(1);
});
it("cancellation is terminal and does not dispatch pending workers", async () => {
  const { root, contract } = await fixture();
  const plan = approvePlan(
    await planRun(root, contract.goal, { contract, mode: "single" }),
  );
  const store = await storeFor(root, plan.runId);
  const { submitCommand } = await import("../src/runtime/commands.js");
  await submitCommand(store, {
    commandId: "cancel-once",
    expectedRevision: 1,
    type: "cancel",
  });
  expect((await startRun(plan)).status).toBe("cancelled");
  expect((await resumeGraphRun(root, plan.runId)).attempts).toBe(0);
});
it("resume refuses unconfirmed invocations and exhausted active budgets", async () => {
  for (const kind of ["uncertain", "budget"]) {
    const { root, contract } = await fixture();
    const plan = approvePlan(
      await planRun(root, contract.goal, { contract, mode: "single" }),
    );
    const store = await storeFor(root, plan.runId);
    await writeFile(join(store.directory, "plan.json"), JSON.stringify(plan));
    await store.acquire();
    if (kind === "uncertain")
      await store.append(
        {
          type: "invocation.started",
          payload: {
            invocationId: "logical",
            attemptId: "lost",
            nodeId: "work",
            connectionId: "mock:process",
            modelId: "mock-1",
            role: "worker",
          },
        },
        1,
      );
    else
      await store.append(
        { type: "runtime.elapsed", payload: { ms: plan.budget.activeMs } },
        1,
      );
    await store.release();
    const state = await resumeGraphRun(root, plan.runId);
    expect(state.status).toBe("awaiting_input");
    expect(state.message).toMatch(
      kind === "uncertain" ? /no confirmed outcome/ : /budget exhausted/,
    );
    expect(state.nodes.work?.status).toBe("pending");
  }
});
it("resumes explicitly reconciled calls without resetting attempt accounting", async () => {
  const { root, contract } = await fixture();
  const plan = approvePlan(await planRun(root, contract.goal, { contract, mode: "single" }));
  const store = await storeFor(root, plan.runId);
  await writeFile(join(store.directory, "plan.json"), JSON.stringify(plan));
  await store.acquire();
  await store.append({ type: "invocation.started", payload: { invocationId: "logical", attemptId: "inspected", nodeId: "work", connectionId: "mock:process", modelId: "mock-1", role: "worker" } }, 1);
  const artifactId = await store.putArtifact({ inspection: "Fixture process outcome explicitly inspected" });
  await store.append({ type: "invocation.reconciled", payload: { attemptId: "inspected", artifactId, processStopped: true, inspectionDigest: "a".repeat(64) } }, 1);
  await store.release();
  const state = await resumeGraphRun(root, plan.runId);
  expect(state.status).toBe("completed");
  expect(state.attempts).toBe(4);
  expect((await store.readAfter()).filter(e => e.type === "invocation.finished")).toHaveLength(3);
}, 30000);
it("requires final T3 confirmation after validation and applies it exactly once", async () => {
  const { root, contract } = await fixture();
  contract.riskTier = "T3";
  const plan = approvePlan(
    await planRun(root, contract.goal, { contract, mode: "single" }),
  );
  const state = await startRun(plan);
  expect(state.status).toBe("awaiting_input");
  expect(state.message).toMatch(/T3/);
  expect(await git(root, ["rev-parse", "HEAD"])).toBe(plan.baseHead);
  const store = await storeFor(root, plan.runId);
  const { submitCommand } = await import("../src/runtime/commands.js");
  await submitCommand(store, {
    commandId: "t3-final",
    expectedRevision: state.revision,
    type: "approve_final",
  });
  const result = await resumeGraphRun(root, plan.runId);
  expect(result.status).toBe("completed");
  expect(result.attempts).toBe(state.attempts);
  expect(
    await git(root, ["rev-list", "--count", `${plan.baseHead}..HEAD`]),
  ).toBe("1");
}, 30000);

it.each(["running", "verifying", "retry_wait", "blocked"])(
  "resumes a reconciled %s node without resetting iterations",
  async (status) => {
    const { root, contract } = await fixture();
    const plan = approvePlan(
      await planRun(root, "Explain repository", { contract, mode: "answer" }),
    );
    const store = await storeFor(root, plan.runId);
    await writeFile(join(store.directory, "plan.json"), JSON.stringify(plan));
    await store.acquire();
    await store.append(
      {
        type: "node.status",
        payload: {
          nodeId: "answer",
          generation: 0,
          status: "running",
          iteration: 2,
        },
      },
      1,
    );
    if (status !== "running")
      await store.append(
        {
          type: "node.status",
          payload: { nodeId: "answer", generation: 0, status: status as any },
        },
        1,
      );
    await store.release();
    const result = await resumeGraphRun(root, plan.runId);
    expect(result.status).toBe("completed");
    expect(result.nodes.answer?.iteration).toBe(2);
    expect(result.attempts).toBe(1);
  },
);
it("records stale queued commands as conflicts and keeps provider failures blocked", async () => {
  const { root, contract, config } = await fixture();
  config.connections = [];
  const plan = approvePlan(
    await planRun(root, "Explain project", {
      contract,
      config,
      mode: "answer",
    }),
  );
  const store = await storeFor(root, plan.runId);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(store.directory, "commands"), { recursive: true });
  await writeFile(
    join(store.directory, "commands", "stale.json"),
    JSON.stringify({ commandId: "stale", expectedRevision: 9, type: "cancel" }),
  );
  const result = await startRun(plan);
  expect(result.status).toBe("awaiting_input");
  expect(result.commands.stale).toEqual({ error: "revision_conflict" });
  expect(result.nodes.answer?.status).toBe("blocked");
  expect(result.attempts).toBe(0);
});

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunStore } from "../src/storage/run-store.js";
import { recoverOwner } from "../src/runtime/recovery.js";
import { WorkspaceManager, git } from "../src/workspace/manager.js";
import { deliverResult } from "../src/workspace/integration.js";
import { checkScope } from "../src/loop/runner.js";
import { loadLoopCheckpoint, saveLoopCheckpoint } from "../src/loop/state.js";
import {
  DEFAULT_BUDGET,
  digest,
  type NodeResult,
  type NodeSpec,
} from "../src/graph/schema.js";
import { singleGraph } from "../src/graph/compiler.js";
import { runCommand } from "../src/util.js";
import { rankMeasuredRoutes } from "../src/gateway/measurements.js";
import type { RouteEntry } from "../src/types.js";

const node: NodeSpec = {
  nodeId: "work",
  generation: 0,
  kind: "worker",
  taskType: "backend_core",
  goal: "Change one file",
  readPaths: ["**"],
  writePaths: ["a.txt", "b.bin"],
  acceptanceCriteria: ["Check result"],
  requiredCapabilities: [],
  inputArtifacts: [],
  verifierIds: ["check"],
  budget: { maxIterations: 6 },
};
async function project() {
  const root = await mkdtemp(join(tmpdir(), "ralph-recovery-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Test"]);
  await git(root, ["config", "user.email", "test@localhost"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await writeFile(join(root, "a.txt"), "initial\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  const base = await git(root, ["rev-parse", "HEAD"]);
  const store = new RunStore(join(root, ".git", "ralph"), "recover-run");
  await store.acquire();
  const manager = new WorkspaceManager(root, store, base);
  return { root, base, store, manager };
}
async function result(
  f: Awaited<ReturnType<typeof project>>,
  id: string,
  deps: NodeResult[] = [],
  content = id,
): Promise<NodeResult> {
  const input = await f.manager.prepare(id, 0, deps);
  await writeFile(join(input.root, `${id}.txt`), content + "\n");
  const outputHead = await f.manager.checkpoint(input.root, id, 0, 1);
  return {
    nodeId: id,
    generation: 0,
    inputDigest: input.inputDigest,
    inputHead: input.inputHead,
    outputHead,
    workspace: input.root,
    outcome: "completed",
    artifactIds: [],
    evidenceIds: [],
    summary: "done",
  };
}
describe("worktree input and delivery recovery", () => {
  it("applies common ancestry once and preserves binary, rename and trailing whitespace patches", async () => {
    const f = await project();
    try {
      const shared = await result(f, "shared");
      const left = await result(f, "left", [shared]);
      const right = await result(f, "right", [shared]);
      const combined = await f.manager.prepare("merge", 0, [
        shared,
        left,
        shared,
        right,
      ]);
      for (const id of ["shared", "left", "right"])
        expect(await readFile(join(combined.root, `${id}.txt`), "utf8")).toBe(
          `${id}\n`,
        );
      expect(
        await f.manager.prepare("merge", 0, [shared, left, shared, right]),
      ).toEqual(combined);
      await expect(f.manager.prepare("merge", 0, [left])).rejects.toThrow(
        /input changed/,
      );
      const input = await f.manager.prepare("binary", 0, []);
      await git(input.root, ["mv", "a.txt", "renamed.txt"]);
      const binary = Buffer.from([0, 1, 2, 255, 128, 0]);
      await writeFile(join(input.root, "b.bin"), binary);
      await writeFile(join(input.root, "spaces.txt"), "space  \n\n");
      const head = await f.manager.checkpoint(input.root, "binary", 0, 1);
      const assembled = await f.manager.prepare("binary-merge", 0, [
        {
          ...left,
          nodeId: "binary",
          inputHead: input.inputHead,
          outputHead: head,
        },
      ]);
      expect(await readFile(join(assembled.root, "b.bin"))).toEqual(binary);
      expect(await readFile(join(assembled.root, "spaces.txt"), "utf8")).toBe(
        "space  \n\n",
      );
      expect(await readFile(join(assembled.root, "renamed.txt"), "utf8")).toBe(
        "initial\n",
      );
    } finally {
      await f.store.release();
    }
  }, 30000);
  it("reuses a delivery receipt after the branch moved to the validated result", async () => {
    const f = await project();
    try {
      const r = await result(f, "change");
      const receipt = join(f.store.directory, "integration", "delivery.json");
      const first = await deliverResult(
        f.root,
        r.workspace!,
        f.base,
        "main",
        f.store.runId,
        receipt,
      );
      expect(
        await deliverResult(
          f.root,
          r.workspace!,
          f.base,
          "main",
          f.store.runId,
          receipt,
        ),
      ).toBe(first);
      expect(
        await git(f.root, ["rev-list", "--count", `${f.base}..HEAD`]),
      ).toBe("1");
      await expect(
        deliverResult(
          f.root,
          r.workspace!,
          f.base,
          "other",
          f.store.runId,
          receipt,
        ),
      ).rejects.toThrow(/receipt input/);
    } finally {
      await f.store.release();
    }
  });
  it.each(["dirty", "commit", "branch"])(
    "preserves user %s changes and the result branch",
    async (kind) => {
      const f = await project();
      try {
        const r = await result(f, "change");
        if (kind === "branch")
          await git(f.root, ["switch", "-c", "user-branch"]);
        else {
          await writeFile(join(f.root, "a.txt"), "User edits\n");
          if (kind === "commit") {
            await git(f.root, ["add", "."]);
            await git(f.root, ["commit", "-m", "User commit"]);
          }
        }
        const before = await git(f.root, ["rev-parse", "HEAD"]);
        await expect(
          deliverResult(
            f.root,
            r.workspace!,
            f.base,
            "main",
            f.store.runId,
            join(f.store.directory, "delivery.json"),
          ),
        ).rejects.toThrow(/User workspace changed/);
        expect(await git(f.root, ["rev-parse", "HEAD"])).toBe(before);
        expect(
          await git(f.root, [
            "rev-parse",
            `refs/heads/ralph/result-${f.store.runId}`,
          ]),
        ).toMatch(/^[0-9a-f]{40}$/);
        if (kind !== "branch")
          expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe(
            "User edits\n",
          );
      } finally {
        await f.store.release();
      }
    },
  );
  it("retains conflicting dependency inputs for inspection", async () => {
    const f = await project();
    try {
      const heads: NodeResult[] = [];
      for (const id of ["left", "right"]) {
        const input = await f.manager.prepare(id, 0, []);
        await writeFile(join(input.root, "a.txt"), id + "\n");
        heads.push({
          nodeId: id,
          generation: 0,
          inputDigest: input.inputDigest,
          inputHead: input.inputHead,
          workspace: input.root,
          outputHead: await f.manager.checkpoint(input.root, id, 0, 1),
          outcome: "completed",
          artifactIds: [],
          evidenceIds: [],
          summary: id,
        });
      }
      await expect(f.manager.prepare("merge", 0, heads)).rejects.toThrow();
      expect(
        await git(join(f.store.directory, "workspaces", "merge-0"), [
          "ls-files",
          "-u",
        ]),
      ).toContain("a.txt");
      expect(await git(f.root, ["rev-parse", "HEAD"])).toBe(f.base);
    } finally {
      await f.store.release();
    }
  });
  it("checks cumulative committed and new changes against node scope", async () => {
    const f = await project();
    try {
      await writeFile(join(f.root, "a.txt"), "valid\n");
      await git(f.root, ["add", "."]);
      await git(f.root, ["commit", "-m", "worker"]);
      await checkScope(f.root, f.base, node, []);
      await writeFile(join(f.root, "outside.txt"), "no");
      await expect(checkScope(f.root, f.base, node, [])).rejects.toThrow(
        /outside/,
      );
      await expect(
        checkScope(f.root, f.base, { ...node, writePaths: ["**"] }, ["a.txt"]),
      ).rejects.toThrow(/scope/);
    } finally {
      await f.store.release();
    }
  });
  it.each([false, true])(
    "recovers a validated iteration across its commit boundary: committed=%s",
    async (committed) => {
      const f = await project();
      try {
        const input = await f.manager.prepare(node.nodeId, 0, []);
        expect(
          await loadLoopCheckpoint(f.store, node, input.inputDigest),
        ).toBeUndefined();
        await writeFile(join(input.root, "a.txt"), "verified\n");
        await git(input.root, ["add", "."]);
        const evidenceId = await f.store.putArtifact({
          verifier: { ok: true },
        });
        const saved = {
          tree: await git(input.root, ["write-tree"]),
          nodeDigest: digest(node),
          iteration: 1,
          fingerprint: "pass",
          score: 100,
          stagnation: 0,
          memory: "verified fact",
          result: {
            nodeId: node.nodeId,
            generation: 0,
            inputDigest: input.inputDigest,
            inputHead: input.inputHead,
            workspace: input.root,
            outcome: "completed" as const,
            artifactIds: [evidenceId],
            evidenceIds: [evidenceId],
            summary: "pass",
          },
        };
        await saveLoopCheckpoint(f.store, node, saved);
        if (committed)
          await f.manager.checkpoint(input.root, node.nodeId, 0, 1);
        const restored = await loadLoopCheckpoint(
          f.store,
          node,
          input.inputDigest,
        );
        expect(restored?.result.outcome).toBe("completed");
        expect(restored?.result.outputHead).toBe(
          await git(input.root, ["rev-parse", "HEAD"]),
        );
        expect(
          await git(input.root, [
            "rev-list",
            "--count",
            `${input.inputHead}..HEAD`,
          ]),
        ).toBe("1");
        await expect(
          loadLoopCheckpoint(f.store, node, "changed"),
        ).rejects.toThrow(/input/);
        await writeFile(join(input.root, "a.txt"), "User change\n");
        await expect(
          loadLoopCheckpoint(f.store, node, input.inputDigest),
        ).rejects.toThrow(/files changed/);
      } finally {
        await f.store.release();
      }
    },
  );
});
describe("supervisor ownership and state transitions", () => {
  it("refuses live owners and releases only confirmed dead owners", async () => {
    const f = await project();
    await expect(recoverOwner(f.store.root)).rejects.toThrow(/still alive/);
    await f.store.release();
    await recoverOwner(f.store.root);
    const path = join(f.store.root, "locks", "graph-owner.json");
    await writeFile(
      path,
      JSON.stringify({ pid: 123456, token: "old", runId: f.store.runId }),
    );
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    try {
      await recoverOwner(f.store.root);
      expect(await readdir(join(f.store.root, "locks"))).not.toContain(
        "graph-owner.json",
      );
    } finally {
      spy.mockRestore();
    }
  });
  it("never replaces a dead owner whose invocation outcome is uncertain", async () => {
    const f = await project();
    await f.store.append(
      {
        type: "invocation.started",
        payload: {
          invocationId: "logical",
          attemptId: "attempt",
          nodeId: "work",
          connectionId: "mock",
          modelId: "model",
          role: "worker",
        },
      },
      1,
    );
    await f.store.release();
    const path = join(f.store.root, "locks", "graph-owner.json");
    await writeFile(
      path,
      JSON.stringify({ pid: 123456, token: "old", runId: f.store.runId }),
    );
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    try {
      await expect(recoverOwner(f.store.root)).rejects.toThrow(/Unconfirmed/);
      expect(JSON.parse(await readFile(path, "utf8")).token).toBe("old");
    } finally {
      spy.mockRestore();
    }
  });
  it("rejects invalid transitions before appending and permits later valid events", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-transitions-")),
      store = new RunStore(root, "state");
    await store.acquire();
    try {
      await store.append(
        {
          type: "graph.revised",
          payload: { graph: singleGraph("state", node) },
        },
        1,
      );
      await expect(
        store.append(
          {
            type: "node.status",
            payload: { nodeId: "work", generation: 0, status: "completed" },
          },
          1,
        ),
      ).rejects.toThrow(/transition/);
      await expect(
        store.append(
          { type: "run.status", payload: { status: "completed" } },
          1,
        ),
      ).rejects.toThrow(/every node/);
      expect((await store.state()).seq).toBe(1);
      await store.append(
        {
          type: "node.status",
          payload: {
            nodeId: "work",
            generation: 0,
            status: "running",
            iteration: 2,
          },
        },
        1,
      );
      await expect(
        store.append(
          {
            type: "node.status",
            payload: {
              nodeId: "work",
              generation: 0,
              status: "running",
              iteration: 1,
            },
          },
          1,
        ),
      ).rejects.toThrow(/decrease/);
      await store.append(
        {
          type: "node.status",
          payload: { nodeId: "work", generation: 0, status: "interrupted" },
        },
        1,
      );
      await store.append(
        {
          type: "node.status",
          payload: { nodeId: "work", generation: 0, status: "pending" },
        },
        1,
      );
      expect((await store.state()).nodes.work?.iteration).toBe(2);
    } finally {
      await store.release();
    }
  });
  it("waits for subprocess shutdown and does not spawn pre-cancelled work", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-cancel-")),
      pidFile = join(root, "pid");
    const c = new AbortController();
    const result = runCommand(
      process.execPath,
      [
        "-e",
        `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
      ],
      { signal: c.signal },
    );
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) {
      pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      if (!pid) await new Promise((r) => setTimeout(r, 10));
    }
    c.abort(new Error("Operator stopped"));
    await expect(result).rejects.toThrow(/Operator stopped/);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(
      runCommand(process.execPath, ["-e", "throw Error('should not run')"], {
        signal: c.signal,
      }),
    ).rejects.toThrow(/Operator stopped/);
    await expect(
      runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/timed out/);
  });
});
it("compares routing measurements only with adequate comparable evidence", () => {
  const route = {
    connectionId: "one",
    provider: "mock",
    modelId: "a",
    score: 90,
    displayName: "a",
    source: "override",
  } as RouteEntry;
  const routes = [route, { ...route, modelId: "b" }];
  const sample = {
    connectionId: "one",
    modelId: "b",
    taskCategory: "backend_core" as const,
    verifierVersion: "1",
    attempts: 20,
    qualifiedSuccesses: 20,
    meanLatencyMs: 1,
  };
  expect(
    rankMeasuredRoutes(routes, [sample], "backend_core", "balanced", "1"),
  ).toEqual(routes);
  expect(
    rankMeasuredRoutes(
      routes,
      [sample, { ...sample, modelId: "a", qualifiedSuccesses: 10 }],
      "backend_core",
      "balanced",
      "1",
    )[0]?.modelId,
  ).toBe("b");
  expect(
    rankMeasuredRoutes(
      routes,
      [sample, { ...sample, modelId: "a", qualifiedSuccesses: 10 }],
      "backend_core",
      "balanced",
      "2",
    ),
  ).toEqual(routes);
});

it("retains a final conflict snapshot and reopens its receipt without applying twice", async () => {
  const f = await project();
  try {
    const results: NodeResult[] = [];
    for (const id of ["left", "right"]) {
      const input = await f.manager.prepare(id, 0, []);
      await writeFile(join(input.root, "a.txt"), id + "\n");
      results.push({
        nodeId: id,
        generation: 0,
        inputDigest: input.inputDigest,
        inputHead: input.inputHead,
        outputHead: await f.manager.checkpoint(input.root, id, 0, 1),
        workspace: input.root,
        outcome: "completed",
        artifactIds: [],
        evidenceIds: [],
        summary: id,
      });
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      let captured: any;
      try {
        await f.manager.prepare("final-conflict", 0, results, {
          retainConflicts: true,
        });
      } catch (e) {
        captured = e;
      }
      expect(captured?.code).toBe("integration_conflict");
      expect(captured?.input?.inputHead ?? captured?.inputHead).toBeDefined();
    }
    const receipt = JSON.parse(
      await readFile(
        join(
          f.store.directory,
          "nodes",
          "final-conflict",
          "0",
          "workspace.json",
        ),
        "utf8",
      ),
    );
    expect(receipt.conflictErrors).toHaveLength(1);
    expect(await git(receipt.root, ["status", "--porcelain"])).toBe("");
    expect(await readFile(join(receipt.root, "a.txt"), "utf8")).toContain(
      "<<<<<<<",
    );
    await expect(f.manager.prepare("final-conflict", 0, [])).rejects.toThrow(
      /input changed/,
    );
  } finally {
    await f.store.release();
  }
});
it("Git delivery transaction rejects stale locks and dirty files without losing user data", async () => {
  const { commitDelivery } = await import("../src/workspace/transaction.js");
  const { unlink } = await import("node:fs/promises");
  const f = await project();
  try {
    const r = await result(f, "ready");
    await expect(
      commitDelivery(f.root, "main", "bad", r.outputHead!),
    ).rejects.toThrow(/Invalid delivery/);
    const lock = join(f.root, ".git", "HEAD.lock");
    await writeFile(lock, "existing transaction");
    await expect(
      commitDelivery(f.root, "main", f.base, r.outputHead!),
    ).rejects.toThrow();
    expect(await readFile(lock, "utf8")).toBe("existing transaction");
    await unlink(lock);
    await writeFile(join(f.root, "a.txt"), "User edit\n");
    await expect(
      commitDelivery(f.root, "main", f.base, r.outputHead!),
    ).rejects.toThrow(/User workspace changed/);
    expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("User edit\n");
    expect(await git(f.root, ["rev-parse", "HEAD"])).toBe(f.base);
  } finally {
    await f.store.release();
  }
});
it("rejects recovery races and preserves a changed owner token", async () => {
  const { unlink } = await import("node:fs/promises");
  const empty = await mkdtemp(join(tmpdir(), "ralph-empty-recovery-"));
  await recoverOwner(empty);
  const f = await project();
  const path = join(f.store.root, "locks", "graph-owner.json");
  const original = await readFile(path, "utf8");
  const guard = join(f.store.root, "locks", "graph-recovery.lock");
  await writeFile(guard, "another recovery");
  await expect(recoverOwner(f.store.root)).rejects.toThrow(
    /already in progress/,
  );
  await unlink(guard);
  await writeFile(
    path,
    JSON.stringify({
      pid: process.pid,
      token: "different",
      runId: f.store.runId,
    }),
  );
  await expect(f.store.release()).rejects.toThrow(/ownership changed/);
  await writeFile(path, original);
  await f.store.release();
});
it("validates result identity, durable completion, revisions and terminal run transitions", async () => {
  const { assertTransition } = await import("../src/runtime/transitions.js");
  const { replay } = await import("../src/storage/run-store.js");
  const state = replay("test", []);
  state.seq = 1;
  state.nodes.work = { status: "running", iteration: 1, generation: 0 };
  const complete = {
    type: "node.status",
    payload: { nodeId: "work", generation: 0, status: "completed" },
  } as any;
  expect(() => assertTransition(state, complete)).toThrow(/durable/);
  expect(() =>
    assertTransition(state, {
      ...complete,
      payload: {
        ...complete.payload,
        result: { nodeId: "other", generation: 0, outcome: "completed" },
      },
    }),
  ).toThrow(/identity/);
  expect(() =>
    assertTransition(state, {
      type: "graph.revised",
      payload: { graph: { ...singleGraph("test", node), revision: 3 } },
    }),
  ).toThrow(/exactly once/);
  state.nodes.work.status = "completed";
  expect(() =>
    assertTransition(state, {
      type: "run.status",
      payload: { status: "completed" },
    }),
  ).not.toThrow();
  state.status = "completed";
  expect(() =>
    assertTransition(state, {
      type: "run.status",
      payload: { status: "running" },
    }),
  ).toThrow(/Terminal/);
});

it("never treats permission-denied process inspection as proof of process death", async () => {
  const f = await project();
  const spy = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(Error("denied"), { code: "EPERM" });
  });
  try {
    await expect(recoverOwner(f.store.root)).rejects.toThrow(/still alive/);
  } finally {
    spy.mockRestore();
    await f.store.release();
  }
});
it("recovery checks the owner token again after reconciling its ledger", async () => {
  const { writeFileSync } = await import("node:fs");
  const f = await project();
  await f.store.release();
  const path = join(f.store.root, "locks", "graph-owner.json");
  await writeFile(
    path,
    JSON.stringify({ runId: f.store.runId, pid: 123456, token: "old" }),
  );
  const spy = vi.spyOn(process, "kill").mockImplementation(() => {
    writeFileSync(
      path,
      JSON.stringify({
        runId: f.store.runId,
        pid: process.pid,
        token: "replacement",
      }),
    );
    throw Object.assign(Error("gone"), { code: "ESRCH" });
  });
  try {
    await expect(recoverOwner(f.store.root)).rejects.toThrow(/Owner changed/);
    expect(JSON.parse(await readFile(path, "utf8")).token).toBe("replacement");
  } finally {
    spy.mockRestore();
  }
});

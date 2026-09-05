import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git, WorkspaceManager } from "../src/workspace/manager.js";
import { statePaths } from "../src/state.js";
import { RunStore } from "../src/storage/run-store.js";
import { singleGraph } from "../src/graph/compiler.js";
import {
  inspectInterruptedRun,
  reconcileInterruptedRun,
} from "../src/runtime/inspection.js";
import { recoverOwner } from "../src/runtime/recovery.js";

it("binds explicit reconciliation to retained files and never invents a call result", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-inspect-"));
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Test"]);
  await git(root, ["config", "user.email", "test@localhost"]);
  await writeFile(join(root, "base.txt"), "base");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  const store = new RunStore((await statePaths(root)).root, "inspection");
  await store.acquire();
  const graph = singleGraph("inspection", {
    taskType: "backend_core",
    goal: "artifact",
    readPaths: ["**"],
    writePaths: ["artifact.txt"],
    acceptanceCriteria: ["artifact"],
    requiredCapabilities: [],
    inputArtifacts: [],
    verifierIds: ["git diff --check"],
    budget: { maxIterations: 6 },
  });
  await store.append({ type: "graph.revised", payload: { graph } }, 1);
  await writeFile(
    join(store.directory, "plan.json"),
    JSON.stringify({ contract: { exclude: [".git/**"] } }),
  );
  const manager = new WorkspaceManager(
    root,
    store,
    await git(root, ["rev-parse", "HEAD"]),
  );
  const input = await manager.prepare("work", 0, []);
  await writeFile(join(input.root, "artifact.txt"), "partial");
  await store.append(
    {
      type: "invocation.started",
      payload: {
        invocationId: "logical",
        attemptId: "attempt",
        nodeId: "work",
        modelId: "mock",
        connectionId: "mock",
        role: "worker",
      },
    },
    1,
  );
  await expect(inspectInterruptedRun(root, store.runId)).rejects.toThrow(
    /death/,
  );
  await store.release();
  const lock = join(store.root, "locks/graph-owner.json");
  await writeFile(
    lock,
    JSON.stringify({ pid: 2147483647, runId: store.runId, token: "old-owner" }),
  );
  const inspection = await inspectInterruptedRun(root, store.runId);
  expect(inspection.pending).toEqual(["attempt"]);
  await expect(
    reconcileInterruptedRun(
      root,
      store.runId,
      inspection.inspectionDigest,
      false,
    ),
  ).rejects.toThrow(/Confirm/);
  await writeFile(join(input.root, "artifact.txt"), "changed");
  await expect(
    reconcileInterruptedRun(
      root,
      store.runId,
      inspection.inspectionDigest,
      true,
    ),
  ).rejects.toThrow(/changed/);
  const refreshed = await inspectInterruptedRun(root, store.runId);
  await reconcileInterruptedRun(
    root,
    store.runId,
    refreshed.inspectionDigest,
    true,
  );
  const events = await store.readAfter();
  expect(events.some((e) => e.type === "invocation.finished")).toBe(false);
  expect(events.at(-1)?.type).toBe("invocation.reconciled");
  expect((await store.state()).attempts).toBe(1);
  await recoverOwner(store.root);
  await expect(readFile(lock)).rejects.toThrow();
});

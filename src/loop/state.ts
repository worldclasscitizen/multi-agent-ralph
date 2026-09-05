import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { digest, type NodeResult, type NodeSpec } from "../graph/schema.js";
import { durableWrite } from "../storage/journal.js";
import type { RunStore } from "../storage/run-store.js";
import { git } from "../workspace/manager.js";
import { RalphError } from "../util.js";

export interface LoopCheckpoint {
  tree: string;
  nodeDigest: string;
  iteration: number;
  fingerprint: string;
  score: number;
  stagnation: number;
  memory: string;
  result: NodeResult;
}
function path(store: RunStore, node: NodeSpec) {
  return join(
    store.directory,
    "nodes",
    node.nodeId,
    String(node.generation),
    "loop.json",
  );
}
export async function saveLoopCheckpoint(
  store: RunStore,
  node: NodeSpec,
  value: LoopCheckpoint,
) {
  await durableWrite(
    path(store, node),
    JSON.stringify({ value, hash: digest(value) }),
  );
}
/** Reconcile a durable validation receipt with the commit created after it. */
export async function loadLoopCheckpoint(
  store: RunStore,
  node: NodeSpec,
  inputDigest: string,
): Promise<LoopCheckpoint | undefined> {
  let saved;
  try {
    saved = JSON.parse(await readFile(path(store, node), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  const value = saved.value as LoopCheckpoint;
  if (
    saved.hash !== digest(value) ||
    value.nodeDigest !== digest(node) ||
    value.result.inputDigest !== inputDigest
  )
    throw new RalphError(
      "Loop checkpoint input or integrity changed",
      "input_changed",
      10,
    );
  for (const id of value.result.evidenceIds) await store.artifact(id);
  const root = value.result.workspace!;
  let head = await git(root, ["rev-parse", "HEAD"]);
  if (!value.result.outputHead) {
    const message = await git(root, ["log", "-1", "--format=%B"]);
    const expected = [
      `Ralph ${node.nodeId} iteration ${value.iteration}`,
      `Ralph-Run: ${store.runId}`,
      `Ralph-Node: ${node.nodeId}`,
      `Ralph-Generation: ${node.generation}`,
    ];
    if (!expected.every((line) => message.split(/\r?\n/).includes(line))) {
      const { WorkspaceManager } = await import("../workspace/manager.js");
      await git(root, ["add", "-A", "--", "."]);
      if ((await git(root, ["write-tree"])) !== value.tree)
        throw new RalphError(
          "Uncommitted checkpoint files changed",
          "input_changed",
          10,
        );
      head = await new WorkspaceManager(
        root,
        store,
        value.result.inputHead!,
      ).checkpoint(root, node.nodeId, node.generation, value.iteration);
      value.result.outputHead = head;
      await saveLoopCheckpoint(store, node, value);
    }
    if (
      expected.every((line) => message.split(/\r?\n/).includes(line)) &&
      !(await git(root, ["status", "--porcelain"])).trim()
    ) {
      value.result.outputHead = head;
      await saveLoopCheckpoint(store, node, value);
    }
  }
  if (value.result.outputHead && value.result.outputHead !== head)
    throw new RalphError("Preserved worker HEAD changed", "input_changed", 10);
  if (
    value.result.outcome === "completed" &&
    value.result.outputHead &&
    (await git(root, ["status", "--porcelain"])).trim()
  )
    throw new RalphError(
      "Preserved worker files changed after validation",
      "input_changed",
      10,
    );
  return value;
}

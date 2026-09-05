import { readFile, open, unlink, lstat, readlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RunStore } from "../storage/run-store.js";
import { statePaths } from "../state.js";
import { digest, safeId } from "../graph/schema.js";
import { git } from "../workspace/manager.js";
import { checkScope } from "../loop/runner.js";
import { RalphError } from "../util.js";

/** Inspect only this run's retained local work; no model calls or file edits. */
export async function inspectInterruptedRun(
  projectRoot: string,
  runId: string,
) {
  const store = new RunStore((await statePaths(projectRoot)).root, runId);
  const owner = JSON.parse(
    await readFile(join(store.root, "locks/graph-owner.json"), "utf8"),
  );
  if (owner.runId !== runId)
    throw new RalphError("Another run owns the project", "run_locked", 9);
  let stopped = false;
  try {
    process.kill(owner.pid, 0);
  } catch (e) {
    stopped = (e as NodeJS.ErrnoException).code === "ESRCH";
  }
  if (!stopped)
    throw new RalphError("Supervisor death is not confirmed", "run_locked", 9);
  const events = await store.readAfter(),
    graph = await store.graph();
  const resolved = new Set(
    events
      .filter(
        (e) =>
          e.type === "invocation.finished" ||
          e.type === "invocation.reconciled",
      )
      .map((e) => (e.payload as { attemptId: string }).attemptId),
  );
  const pending = events.filter(
    (e) =>
      e.type === "invocation.started" && !resolved.has(e.payload.attemptId),
  );
  const plan = JSON.parse(
    await readFile(join(store.directory, "plan.json"), "utf8"),
  );
  const workspaces = [];
  for (const nodeId of new Set(
    pending.map((e) => (e.payload as { nodeId: string }).nodeId),
  )) {
    const node = graph.nodes.find((n) => n.nodeId === nodeId);
    if (!node)
      throw new RalphError(
        "Planning interruption needs a new reviewed request",
        "input_required",
        10,
      );
    const root = join(
      store.directory,
      "workspaces",
      `${safeId(nodeId)}-${node.generation}`,
    );
    const receipt = JSON.parse(
      await readFile(
        join(
          store.directory,
          "nodes",
          nodeId,
          String(node.generation),
          "workspace.json",
        ),
        "utf8",
      ),
    );
    await checkScope(root, receipt.inputHead, node, plan.contract.exclude);
    const untracked = [];
    for (const path of (
      await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    )
      .split("\0")
      .filter(Boolean)) {
      const file = join(root, path),
        info = await lstat(file);
      untracked.push({
        path,
        digest: digest(
          info.isSymbolicLink()
            ? await readlink(file)
            : (await readFile(file)).toString("base64"),
        ),
      });
    }
    workspaces.push({
      nodeId,
      generation: node.generation,
      root,
      inputHead: receipt.inputHead,
      head: await git(root, ["rev-parse", "HEAD"]),
      diff: await git(root, ["diff", "--binary", receipt.inputHead, "--"]),
      untracked,
    });
  }
  const inspection = {
    runId,
    seq: events.at(-1)?.seq ?? 0,
    ownerToken: owner.token,
    pending: pending.map((e) => (e.payload as { attemptId: string }).attemptId),
    workspaces,
  };
  return { ...inspection, inspectionDigest: digest(inspection) };
}

/** Explicit operator attestation seals uncertainty; the next iteration inspects retained work. */
export async function reconcileInterruptedRun(
  projectRoot: string,
  runId: string,
  approvedDigest: string,
  processStopped: boolean,
) {
  if (!processStopped)
    throw new RalphError(
      "Confirm every provider subprocess has stopped",
      "input_required",
      10,
    );
  const store = new RunStore((await statePaths(projectRoot)).root, runId);
  const path = join(store.root, "locks/graph-recovery.lock"),
    guard = await open(path, "wx", 0o600);
  try {
    const recoveryToken = randomUUID();
    await guard.writeFile(
      JSON.stringify({ pid: process.pid, token: recoveryToken }),
    );
    await guard.sync();
    const inspection = await inspectInterruptedRun(projectRoot, runId);
    if (inspection.inspectionDigest !== approvedDigest)
      throw new RalphError(
        "Inspection changed; review it again",
        "revision_conflict",
        10,
      );
    await store.acquire({ ownerToken: inspection.ownerToken, recoveryToken });
    const artifactId = await store.putArtifact({
      ...inspection,
      processStopped: true,
      note: "Operator reviewed retained local work and explicitly authorized continued execution. Original call outcome and usage remain unknown.",
    });
    for (const attemptId of inspection.pending)
      await store.append(
        {
          type: "invocation.reconciled",
          payload: {
            attemptId,
            artifactId,
            processStopped: true,
            inspectionDigest: approvedDigest,
          },
        },
        (await store.state()).revision,
      );
    return {
      runId,
      artifactId,
      reconciled: inspection.pending,
      next: `ralph resume ${runId}`,
    };
  } finally {
    await store.release();
    await guard.close();
    await unlink(path);
  }
}

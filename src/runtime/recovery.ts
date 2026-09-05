import { readFile, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { RunStore } from "../storage/run-store.js";
import { RalphError } from "../util.js";
/** Conservative recovery: neither a live owner nor an uncertain invocation is replaced. */
export async function recoverOwner(root: string): Promise<void> {
  const recoveryPath = join(root, "locks", "graph-recovery.lock");
  let guard;
  try {
    guard = await open(recoveryPath, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new RalphError("Recovery already in progress", "run_locked", 9);
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  try {
    const path = join(root, "locks", "graph-owner.json");
    let old: { pid: number; token: string; runId: string };
    try {
      old = JSON.parse(await readFile(path, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    let alive = true;
    try {
      process.kill(old.pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
    }
    if (alive)
      throw new RalphError(
        "Previous supervisor is still alive",
        "run_locked",
        9,
      );
    const store = new RunStore(root, old.runId);
    const events = await store.journal.read(true);
    const finished = new Set(
      events
        .filter(
          (e) =>
            e.type === "invocation.finished" ||
            e.type === "invocation.reconciled",
        )
        .map((e) =>
          e.type === "invocation.finished" || e.type === "invocation.reconciled"
            ? e.payload.attemptId
            : "",
        ),
    );
    if (
      events.some(
        (e) =>
          e.type === "invocation.started" && !finished.has(e.payload.attemptId),
      )
    )
      throw new RalphError(
        "Unconfirmed provider invocation; inspect preserved work and process state",
        "uncertain_invocation",
        10,
      );
    const current = JSON.parse(await readFile(path, "utf8"));
    if (current.token !== old.token)
      throw new RalphError("Owner changed during recovery", "run_locked", 9);
    await unlink(path);
  } finally {
    await guard.close();
    await unlink(recoveryPath);
  }
}

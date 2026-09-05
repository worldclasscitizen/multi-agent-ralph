import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const [root, boundary] = process.argv.slice(2);
let reached = false;
function pause() {
  if (reached) return;
  reached = true;
  writeFileSync(join(root, "..", "boundary.json"), JSON.stringify({ pid: process.pid, boundary }));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
// Test-only process interception: the real Git checkout completes before we kill its owner.
const spawn = childProcess.spawn;
childProcess.spawn = function(command, args, options) {
  const child = spawn(command, args, options);
  if (boundary === "delivery_checkout" && command === "git" && args[0] === "read-tree") {
    const emit = child.emit;
    child.emit = function(event, ...values) {
      if (event === "close" && values[0] === 0) pause();
      return emit.call(this, event, ...values);
    };
  }
  return child;
};
syncBuiltinESMExports();
const { RunStore } = await import("../dist/storage/run-store.js");
const { WorkspaceManager } = await import("../dist/workspace/manager.js");
const originalAppend = RunStore.prototype.append;
RunStore.prototype.append = async function(event, ...args) {
  if (boundary === "invocation_before" && event.type === "invocation.started") pause();
  if (boundary === "invocation_after" && event.type === "invocation.finished") pause();
  if (boundary === "delivery_after" && event.type === "run.status" && event.payload.status === "completed") pause();
  return originalAppend.call(this, event, ...args);
};
const checkpoint = WorkspaceManager.prototype.checkpoint;
WorkspaceManager.prototype.checkpoint = async function(...args) {
  const value = await checkpoint.apply(this, args);
  if (boundary === "commit_after") pause();
  return value;
};
const { readFile } = await import("node:fs/promises");
const { startRun } = await import("../dist/runtime/supervisor.js");
const plan = JSON.parse(await readFile(join(root, "..", "approved.json"), "utf8"));
const result = await startRun(plan);
console.error(JSON.stringify(result));
process.exitCode = 2; // Every selected boundary must have been reached before completion.

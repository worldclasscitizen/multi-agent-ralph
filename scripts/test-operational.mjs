import { mkdtemp, mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { git } from "../dist/workspace/manager.js";
import { saveConfig } from "../dist/state.js";
import { validateContract } from "../dist/contracts.js";
import { planRun } from "../dist/nodes/planner.js";
import { approvePlan } from "../dist/interaction/approval.js";
import { resumeGraphRun, storeFor } from "../dist/runtime/supervisor.js";
import { inspectInterruptedRun, reconcileInterruptedRun } from "../dist/runtime/inspection.js";
import { atomicJson, report } from "./lib/release.mjs";
const exec = promisify(execFile);
const boundaries = ["invocation_before", "invocation_after", "commit_after", "delivery_checkout", "delivery_after"];
const repetitions = Number(process.env.RALPH_OPERATIONAL_REPETITIONS ?? 5);
const checks = [], observations = [];
for (let repetition = 0; repetition < repetitions; repetition++) for (const boundary of boundaries) {
  const parent = await mkdtemp(join(tmpdir(), "ralph-operational-")), root = join(parent, "project");
  await mkdir(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  await git(root, ["config", "user.name", "Operational fixture"]);
  await writeFile(join(root, "README.md"), "Fixture\n");
  await git(root, ["add", "."]); await git(root, ["commit", "-m", "base"]);
  const base = await git(root, ["rev-parse", "HEAD"]);
  const route = { connectionId: "mock", provider: "mock", modelId: "mock-1", displayName: "Mock", score: 0, source: "override" };
  const roles = ["planning_architecture", "frontend_visual", "backend_core", "tdd_debugging", "static_review", "delivery_evidence", "contractPlanner", "router", "critic", "metaPrompter", "worker", "adjudicator"];
  const commands = [`node -e "require('node:assert/strict').equal(require('node:fs').readFileSync('ralph-smoke.txt','utf8').trim(),'ok')"`, "git diff --check"];
  await saveConfig(root, { schemaVersion: 1, projectRoot: root, preset: "balanced", initializedAt: new Date().toISOString(),
    connections: [{ id: "mock", adapter: "generic-process", provider: "mock", enabled: true, mode: "process", command: [process.execPath, resolve("tests/fixtures/mock-agent.mjs")] }],
    routes: Object.fromEntries(roles.map((r) => [r, [route]])), overrides: {}, verifierCommands: commands, catalogVersion: 3 });
  const contract = validateContract({ taskType: "backend_core", goal: "Create the smoke artifact", include: ["ralph-smoke.txt"], exclude: [".git/**"], acceptanceCriteria: ["Artifact is ok"], verifierCommands: commands, requiredArtifacts: ["ralph-smoke.txt"] }, root);
  const approved = approvePlan(await planRun(root, contract.goal, { contract, mode: "single" }));
  await atomicJson(join(parent, "approved.json"), approved);
  const child = spawn(process.execPath, [resolve("scripts/operational-child.mjs"), root, boundary], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let errors = ""; child.stderr.on("data", (b) => errors += b.toString());
  const exited = new Promise((done) => child.once("close", done));
  let hit = false;
  try {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && child.exitCode === null) {
      try { await readFile(join(parent, "boundary.json")); hit = true; break; } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(hit, `Boundary not reached: ${boundary}; ${errors}`);
    if (process.platform === "win32") await exec("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    else child.kill("SIGKILL");
    await exited;
    const store = await storeFor(root, approved.runId);
    const before = await store.readAfter();
    let state, blocked;
    try { state = await resumeGraphRun(root, approved.runId); } catch (e) { blocked = e.message; }
    if (boundary === "invocation_after") {
      assert.match(blocked ?? "", /Unconfirmed provider invocation/);
      assert.equal((await store.readAfter()).filter((e) => e.type === "invocation.started").length, before.filter((e) => e.type === "invocation.started").length);
      assert.equal(await git(root, ["rev-parse", "HEAD"]), base);
      const inspection = await inspectInterruptedRun(root, approved.runId);
      assert.ok(inspection.pending.length > 0);
      await assert.rejects(reconcileInterruptedRun(root, approved.runId, inspection.inspectionDigest, false), /Confirm/);
      await assert.rejects(reconcileInterruptedRun(root, approved.runId, "stale", true), /Inspection changed/);
      // This harness killed and awaited the owned process tree above; partial files are inspected before approval.
      await reconcileInterruptedRun(root, approved.runId, inspection.inspectionDigest, true);
      state = await resumeGraphRun(root, approved.runId);
      assert.equal(state.status, "completed");
      assert.equal(state.nodes.work.iteration, 2);
      assert.equal(await git(root, ["rev-list", "--count", `${base}..HEAD`]), "1");
    } else if (boundary === "delivery_checkout") {
      assert.equal(state?.status, "awaiting_input");
      assert.match(state?.message ?? "", /workspace changed|delivery/i);
      assert.equal(await git(root, ["rev-parse", "HEAD"]), base);
      assert.equal((await readFile(join(root, "ralph-smoke.txt"), "utf8")).trim(), "ok");
      // Explicit operator recovery: inspect the exact retained result before advancing the unchanged ref.
      const result = await git(root, ["rev-parse", `refs/heads/ralph/result-${approved.runId}`]);
      assert.equal((await git(root, ["diff", "--name-only", result, "--"])).trim(), "");
      for (const file of ["HEAD.lock", "refs/heads/main.lock"]) {
        const lock = await git(root, ["rev-parse", "--git-path", file]);
        await unlink(resolve(root, lock)).catch(e => { if (e.code !== "ENOENT") throw e; });
      }
      await git(root, ["update-ref", "HEAD", result, base]);
      state = await resumeGraphRun(root, approved.runId);
      assert.equal(state.status, "completed");
      assert.equal(state.resultHead, result);
    } else {
      assert.equal(state?.status, "completed", JSON.stringify(state ?? blocked));
      assert.equal(await git(root, ["rev-list", "--count", `${base}..HEAD`]), "1");
      assert.equal((await readFile(join(root, "ralph-smoke.txt"), "utf8")).trim(), "ok");
      const again = await resumeGraphRun(root, approved.runId);
      assert.equal(again.resultHead, state.resultHead);
    }
    checks.push({ name: `${boundary}/${repetition + 1}`, passed: true });
    observations.push({ boundary, repetition: repetition + 1, outcome: state?.status ?? "blocked", preserved: true });
  } catch (e) {
    checks.push({ name: `${boundary}/${repetition + 1}`, passed: false, detail: String(e) });
    observations.push({ boundary, repetition: repetition + 1, fixture: parent, error: String(e) });
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  console.log(JSON.stringify(checks.at(-1)));
}
await atomicJson(resolve(`.release/evidence/operational-${process.platform}.json`), await report("operational", checks, { repetitions, boundaries, observations }));
if (checks.some((c) => !c.passed)) process.exitCode = 1;

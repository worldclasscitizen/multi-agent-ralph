import { mkdtemp, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixture, oracle } from "./live-fixture.mjs";
import { CodexBuiltinAdapter } from "../dist/providers/cli.js";
import { LiveBudget } from "./lib/live-budget.mjs";
import { createEvidenceReuse, verifyEvidenceReuse } from "./lib/evidence-reuse.mjs";
import { atomicJson, json, report, subject, FUNCTIONAL_CHECKS } from "./lib/release.mjs";
import { assertFunctionalPreflight } from "./lib/live-preflight.mjs";

const exec = promisify(execFile), source = resolve("."), args = process.argv.slice(2), live = args.includes("--live");
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const model = arg("--model", "gpt-5.6-luna"), mode = live ? "live" : "mock";
const campaign = resolve(`.release/functional-${mode}.json`), budgetPath = resolve(live ? ".release/live-budget.json" : ".release/functional-mock-budget.json");
const target = await subject();
let cliVersion = "mock-only";
if (live) {
  if ((await exec("git", ["status", "--porcelain", "--untracked-files=normal"], { windowsHide: true })).stdout.trim()) throw new Error("Commit the tested source before real calls");
  // A new invocation is never an implicit retry of a failed or interrupted run.
  try { await readFile(campaign); throw new Error("A functional campaign already exists; inspect its retained outcome before any new calls"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const mock = await json(resolve(".release/functional-mock.json"));
  if (mock.subject.runtimeDigest !== target.runtimeDigest || mock.subject.testDigest !== target.testDigest || mock.model !== model) throw new Error("Matching functional mock required");
  const adapter = new CodexBuiltinAdapter(), detected = await adapter.detect(), auth = await adapter.authStatus();
  if (!detected.installed || auth.status !== "authenticated") throw new Error("Recorded Codex connection must be installed and authenticated");
  cliVersion = detected.version;
  const originalPath = resolve("docs/project/evidence/live-provider.json"), original = await json(originalPath);
  const reuse = await createEvidenceReuse(source, originalPath, { adapter: "codex-builtin", model, cliVersion, platform: process.platform, node: process.version });
  const currentProvider = { ...original, schemaVersion: 2, subject: target, reuse };
  await verifyEvidenceReuse(currentProvider, resolve("docs/project/evidence"));
  const age = Date.now() - Date.parse(original.checkedAt);
  if (age < 0 || age > 30 * 86400_000) throw new Error("Provider verification expired");
  console.log(JSON.stringify({ preflight: assertFunctionalPreflight(await new LiveBudget(budgetPath).load(), mock) }));
  await atomicJson(resolve("docs/project/evidence/live-provider-current.json"), currentProvider);
} else await atomicJson(budgetPath, { calls: 0 });

const budget = live ? new LiveBudget(budgetPath) : { load: () => json(budgetPath) };
const root = await mkdtemp(join(tmpdir(), `ralph-functional-${mode}-`));
await fixture(root);
const before = await budget.load(), start = Date.now(), output = join(root, ".git", "outcome.json");
await atomicJson(campaign, { status: "running", mode, subject: target, model, fixture: root, startingCalls: before.calls });
let failure, outcome;
try {
  await exec(process.execPath, [resolve("scripts/live-run.mjs"), "functional", root, source, mode, budgetPath, "functional", String(before.calls), model, output], { cwd: source, windowsHide: true, timeout: 1_500_000, maxBuffer: 4_000_000 });
  outcome = await json(output);
  await oracle(root);
} catch (error) {
  failure = String(error.message);
  try { outcome = await json(output); } catch { /* Keep the failure before output was written. */ }
}
const end = await subject(), allowance = await budget.load();
if (end.runtimeDigest !== target.runtimeDigest || end.testDigest !== target.testDigest || end.dependencyDigest !== target.dependencyDigest) failure = "Execution source changed during live verification";
const observation = { mode, subject: target, model, cliVersion, passed: !failure, status: outcome?.status ?? "failed", ...outcome, calls: allowance.calls - before.calls, durationMs: Date.now() - start, fixture: root, ...(failure ? { error: failure } : {}) };
await atomicJson(campaign, observation);
if (live) {
  const { fixture: privatePath, error: privateError, ...details } = observation;
  const value = await report("end_to_end", FUNCTIONAL_CHECKS.map(name => ({ name, passed: !failure })), { ...details, injectedContract: false, injectedGraph: false, allowance, ...(failure ? { failure: "Inspect the retained functional campaign; completion was not established" } : {}), scope: "Windows, recorded Node/model, fresh Codex CLI sessions through the metered generic-process bridge. Natural-language contract and DAG; independent worktrees; scoped behavior checks, independent assessments and external oracle. Single connection concurrency remains one." });
  value.subject = target;
  await atomicJson(resolve("docs/project/evidence/live-functional.json"), value);
}
console.log(JSON.stringify({ passed: !failure, calls: observation.calls, status: observation.status, durationMs: observation.durationMs, ...(failure ? { error: failure.slice(-3000) } : {}) }));
if (failure) process.exitCode = 1;

import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixture, oracle } from "./live-fixture.mjs";
import { LiveBudget } from "./lib/live-budget.mjs";
import { assertLiveCampaignReady } from "./lib/live-preflight.mjs";
import { atomicJson, json, report, subject, BASELINE } from "./lib/release.mjs";
const exec = promisify(execFile), source = resolve(".");
const args = process.argv.slice(2), live = args.includes("--live");
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const model = arg("--model", "gpt-5.6-luna");
const baseline = resolve(".release/baseline"), campaign = resolve(live ? ".release/live-campaign.json" : ".release/mock-campaign.json");
const budgetPath = resolve(live ? ".release/live-budget.json" : ".release/mock-budget.json");
await mkdir(resolve(".release"), { recursive: true });
try { await readFile(join(baseline, "package.json")); }
catch { await exec("git", ["worktree", "add", "--detach", baseline, BASELINE], { windowsHide: true }); }
if ((await exec("git", ["rev-parse", "HEAD"], { cwd: baseline })).stdout.trim() !== BASELINE) throw new Error("Baseline checkout changed");
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Use npm run test:live:release");
try { await readFile(join(baseline, "dist/orchestrator.js")); }
catch {
  await exec(process.execPath, [npm, "ci", "--ignore-scripts"], { cwd: baseline, maxBuffer: 2_000_000 });
  await exec(process.execPath, [npm, "run", "build"], { cwd: baseline, maxBuffer: 2_000_000 });
}
const target = await subject();
let saved;
try { saved = await json(campaign); } catch (e) { if (e.code !== "ENOENT") throw e; }
if (live && saved && (saved.runtimeDigest !== target.runtimeDigest || saved.testDigest !== target.testDigest || saved.model !== model)) throw new Error("Live campaign source/model changed; retained allowance requires an explicit evidence review");
if (!live) await atomicJson(budgetPath, { calls: 0 });
const budget = live ? new LiveBudget(budgetPath) : { load: () => json(budgetPath) };
const observations = live ? saved?.observations ?? [] : [];
if (live) {
  const preflight = await json(resolve(".release/mock-campaign.json"));
  if (preflight.runtimeDigest !== target.runtimeDigest || preflight.testDigest !== target.testDigest || preflight.observations.length !== 4 || preflight.observations.some(o => !o.passed) || preflight.totalCalls !== 18) throw new Error("Matching 18-call mock comparison required before real calls");
  const providerPath = resolve("docs/project/evidence/live-provider.json");
  let provider;
  try { provider = await json(providerPath); } catch (e) { if (e.code !== "ENOENT") throw e; }
  console.log(JSON.stringify({ preflight: assertLiveCampaignReady(await budget.load(), observations, preflight.observations, !provider) }));
  if (!provider) {
    await exec(process.execPath, [resolve("scripts/provider-conformance.mjs"), "--live", "--provider", "codex", "--model", model, "--budget", budgetPath, "--output", resolve(".release/conformance.json")], { windowsHide: true, timeout: 400_000, maxBuffer: 2_000_000 });
    const raw = await json(resolve(".release/conformance.json"));
    provider = await report("provider", raw.checks.map(c => ({ name: c.name, passed: c.status === "pass" })), { adapter: "codex-builtin", model, cliVersion: raw.cliVersion, observations: raw.checks, scope: "CLI transport in the recorded local environment; fresh sessions, no API credentials" });
    await atomicJson(providerPath, provider);
  }
  if (provider.status !== "pass" || provider.subject.runtimeDigest !== target.runtimeDigest || provider.subject.testDigest !== target.testDigest || provider.details.model !== model) throw new Error("Matching provider conformance required");
}
for (const version of ["baseline", "candidate", "baseline", "candidate"]) {
  const index = observations.length;
  if (index >= 4) break;
  const expected = ["baseline", "candidate", "baseline", "candidate"][index];
  const stageSubject = await subject();
  if (stageSubject.runtimeDigest !== target.runtimeDigest || stageSubject.testDigest !== target.testDigest) throw new Error("Source changed during campaign; do not mix verification targets");
  const root = await mkdtemp(join(tmpdir(), `ralph-${live ? "live" : "mock"}-${expected}-`));
  await fixture(root);
  const before = await budget.load(), start = Date.now(), output = join(root, ".git", "outcome.json");
  let failure, state;
  try {
    await exec(process.execPath, [resolve("scripts/live-run.mjs"), expected, root, expected === "baseline" ? baseline : source,
      live ? "live" : "mock", budgetPath, `${expected}-${index + 1}`, String(before.calls), model, output], { cwd: source, windowsHide: true, timeout: 650_000, maxBuffer: 2_000_000 });
    state = await json(output); await oracle(root);
  } catch (e) {
    failure = String(e.message).slice(0, 1500);
    try { state = await json(output); } catch { /* Preserve the execution failure if no terminal state was written. */ }
  }
  const endSubject = await subject();
  if (endSubject.runtimeDigest !== stageSubject.runtimeDigest || endSubject.testDigest !== stageSubject.testDigest) failure = "Source changed during comparison; evidence cannot qualify";
  const after = await budget.load();
  const observation = { version: expected, repetition: Math.floor(index / 2) + 1, passed: !failure, status: state?.status ?? "failed", durationMs: Date.now() - start, calls: after.calls - before.calls, subject: stageSubject, ...(failure ? { error: failure, fixture: root } : {}) };
  observations.push(observation);
  await atomicJson(campaign, { runtimeDigest: target.runtimeDigest, testDigest: target.testDigest, model, observations, totalCalls: after.calls });
  console.log(JSON.stringify(observation));
  if (failure) break;
}
if (live) {
  const allowance = await budget.load();
  const checks = [{ name: "four frozen comparisons", passed: observations.length === 4 }, { name: "independent acceptance and runtime completion", passed: observations.every(o => o.passed) }, { name: "fixed allowance", passed: allowance.calls <= 24 && allowance.activeMs <= 1800000 && !allowance.pending }];
  // Keep local reproduction paths in the private campaign. Public reports contain
  // aggregate results and source identities, never command lines or workspaces.
  const publicObservations = observations.map(({ fixture, error, ...o }) => ({ ...o, ...(error ? { error: "Runtime completion, external acceptance, or source consistency failed; inspect the retained local campaign" } : {}) }));
  const value = await report("comparison", checks, { baselineCommit: BASELINE, model, observations: publicObservations, allowance,
    methodology: "Same frozen two-module task, model, low reasoning effort and fresh Codex CLI transport. Baseline pre-review/meta/worker/post-review; candidate two scoped workers, independent reviews, Git integration and final review. Explicit DAG isolates execution effects from planning variance. Oracle remains outside workspaces. Two paired trials cannot establish general performance superiority." });
  value.subject = target;
  await atomicJson(resolve("docs/project/evidence/live-comparison.json"), value);
}
if (observations.length !== 4 || observations.some(o => !o.passed)) process.exitCode = 1;

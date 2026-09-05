import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rename, open, unlink, readdir } from "node:fs/promises";
import { resolve, dirname, join, relative, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VerificationReportSchema, ReleaseManifestSchema, LiveTestBudgetSchema, assertReleaseSchema } from "../../dist/release/schema.js";
import { PROVIDER_CHECKS, verifyEvidenceReuse } from "./evidence-reuse.mjs";

const exec = promisify(execFile);
export const BASELINE = "e04b387fca1b10ae6668b6b6223fb8c8a530712a";
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export const integrity = (data) => `sha512-${createHash("sha512").update(data).digest("base64")}`;
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(tmp, path);
}
export const json = async (path) => JSON.parse(await readFile(path, "utf8"));
async function git(root, args) { return (await exec("git", args, { cwd: root, maxBuffer: 8_000_000, windowsHide: true })).stdout.trim(); }
export async function subject(root = process.cwd()) {
  const names = [...new Set((await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean))].sort();
  const hashes = async (filter) => {
    const hash = createHash("sha256");
    for (const name of names.filter(filter)) {
      hash.update(name + "\0");
      // Text source is normalized across Git's platform line-ending conversion.
      const data = await readFile(join(root, name));
      hash.update(data.includes(0) ? data : data.toString("utf8").replaceAll("\r\n", "\n"));
    }
    return hash.digest("hex");
  };
  return {
    version: (await json(join(root, "package.json"))).version,
    sourceCommit: await git(root, ["rev-parse", "HEAD"]), sourceTree: await git(root, ["rev-parse", "HEAD^{tree}"]),
    runtimeDigest: await hashes((n) => n.startsWith("src/") || /^assets\/catalog-v2\./.test(n) || n === "package-lock.json"),
    dependencyDigest: sha256((await readFile(join(root, "package-lock.json"), "utf8")).replaceAll("\r\n", "\n")),
    testDigest: await hashes((n) => /^(tests\/fixtures\/live-|scripts\/(live-|provider-conformance|lib\/live-))/.test(n)),
  };
}
export async function report(kind, checks, details = {}, root = process.cwd()) {
  const value = { schemaVersion: 2, kind, subject: await subject(root), checkedAt: new Date().toISOString(),
    runner: { platform: process.platform, node: process.version, ...(process.env.GITHUB_RUN_ID ? { workflowRunId: process.env.GITHUB_RUN_ID } : {}) },
    status: checks.every((c) => c.passed) ? "pass" : "fail", checks, details };
  assertReleaseSchema(VerificationReportSchema, value); return value;
}
export const CRITICAL = ["graph/scheduler.ts", "graph/revisions.ts", "runtime/supervisor.ts", "runtime/recovery.ts", "runtime/transitions.ts", "storage/journal.ts", "storage/run-store.ts", "workspace/manager.ts", "workspace/integration.ts", "workspace/transaction.ts"];
export function coverageChecks(coverage) {
  return [{ name: "global coverage floor", passed: coverage.total?.lines?.pct >= 57.77 && coverage.total?.branches?.pct >= 73.70 },
    ...CRITICAL.map((file) => {
      const entry = Object.entries(coverage).find(([p]) => p.replaceAll("\\", "/").endsWith(`src/${file}`))?.[1];
      return { name: file, passed: Boolean(entry && entry.lines.pct >= 90 && entry.branches.pct >= 90) };
    })];
}
export function validateReports(reports, expected, now = Date.now(), artifactIntegrity) {
  const failures = [];
  for (const r of reports) {
    assertReleaseSchema(VerificationReportSchema, r);
    if (r.status !== "pass" || r.checks.some((c) => !c.passed)) failures.push(`${r.kind}: incomplete checks`);
    if (r.kind === "ci" && artifactIntegrity && r.details.artifactIntegrity !== artifactIntegrity) failures.push("CI tested a different artifact");
    const live = ["provider", "comparison", "end_to_end"].includes(r.kind);
    const keys = live ? ["runtimeDigest", "dependencyDigest", "testDigest"] : ["runtimeDigest", "dependencyDigest", "sourceTree"];
    if (keys.some((k) => r.subject[k] !== expected[k])) failures.push(`${r.kind}: subject mismatch`);
    const age = now - Date.parse(r.checkedAt);
    if (!Number.isFinite(age) || age < -300_000 || age > (live ? 30 : 7) * 86400_000) failures.push(`${r.kind}: stale evidence`);
  }
  for (const os of ["win32", "darwin", "linux"]) for (const node of [22, 24]) {
    if (!reports.some((r) => r.kind === "ci" && r.runner.platform === os && Number(r.runner.node.replace(/^v/, "").split(".")[0]) === node && r.runner.workflowRunId)) failures.push(`Missing CI ${os}/Node ${node}`);
  }
  for (const kind of ["coverage", "operational", "accessibility", "provider", "end_to_end", "catalog"]) {
    if (!reports.some((r) => r.kind === kind)) failures.push(`Missing ${kind} report`);
  }
  for (const r of reports.filter((r) => r.kind === "coverage")) if (coverageChecks(r.details.coverage).some((c) => !c.passed)) failures.push("Coverage below release floor");
  for (const os of ["win32", "darwin", "linux"]) if (!reports.some((r) => r.kind === "operational" && r.runner.platform === os && r.details.repetitions >= 5 && r.details.boundaries?.length >= 5)) failures.push(`Missing process interruption evidence: ${os}`);
  const provider = reports.find((r) => r.kind === "provider");
  if (provider && (!provider.details.model || !provider.details.cliVersion || PROVIDER_CHECKS.some(name => !provider.checks.some(c => c.name === name && c.passed)))) failures.push("Incomplete provider identity/conformance");
  const functional = reports.find(r => r.kind === "end_to_end");
  if (functional) {
    const d = functional.details;
    if (functional.schemaVersion !== 2 || FUNCTIONAL_CHECKS.some(name => !functional.checks.some(c => c.name === name && c.passed)) || d.mode !== "live" || d.status !== "completed" || !d.runId || !d.resultHead || !d.model || !d.cliVersion || d.workerCount !== 2 || d.injectedContract !== false || d.injectedGraph !== false) failures.push("Incomplete live end-to-end evidence");
    try {
      assertReleaseSchema(LiveTestBudgetSchema, d.allowance);
      if (d.allowance.pending || d.allowance.activeMs > d.allowance.maxActiveMs) throw new Error("Unfinished allowance");
    } catch { failures.push("Invalid end-to-end live allowance"); }
  }
  const accessibility = reports.find((r) => r.kind === "accessibility");
  if (accessibility && (accessibility.details.maxNodes < 32 || accessibility.details.revisions < 8 || accessibility.details.logLines < 100000 || !accessibility.details.maxNodes)) failures.push("Incomplete browser scale evidence");
  if (failures.length) throw new Error(failures.join("\n"));
}
export const FUNCTIONAL_CHECKS = ["generated_contract_and_dag", "exact_plan_approval", "isolated_scoped_workers", "behavior_and_independent_review", "integration_and_final_validation", "branch_delivery_completed", "external_oracle_and_frozen_tests", "persistent_live_allowance"];
export function selectReports(rows) {
  const originals = new Set(rows.flatMap(r => r.value.reuse ? [r.value.reuse.originalFile] : []));
  return {
    required: rows.filter(r => r.value.kind !== "comparison" && !originals.has(r.file)),
    references: rows.filter(r => r.value.kind === "comparison" || originals.has(r.file)),
  };
}
export async function validateReportFiles(rows, expected, now = Date.now(), artifactIntegrity, directory, root = process.cwd()) {
  const selected = selectReports(rows);
  for (const r of selected.required) await verifyEvidenceReuse(r.value, directory, root);
  validateReports(selected.required.map(r => r.value), expected, now, artifactIntegrity);
  return selected;
}
export async function readReports(dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json") && !f.startsWith("manifest"));
  const reports = [];
  for (const file of files) {
    const value = await json(join(dir, file));
    if (value.subject && value.kind) reports.push({ file, value, sha256: sha256(await readFile(join(dir, file))) });
  }
  return reports;
}
export async function createManifest(archive, dir, root = process.cwd()) {
  const target = await subject(root), reports = await readReports(dir);
  const data = await readFile(archive);
  const selected = await validateReportFiles(reports, target, Date.now(), integrity(data), dir, root);
  const manifest = { schemaVersion: 2, gateProfile: "stable-functional-v1", releaseId: `ralph-${target.version}`, subject: target,
    artifact: { file: archive.split(/[\\/]/).at(-1), integrity: integrity(data), sha256: sha256(data) },
    reports: selected.required.map(({ file, sha256 }) => ({ file, sha256 })), references: selected.references.map(({ file, sha256 }) => ({ file, sha256 })), createdAt: new Date().toISOString() };
  assertReleaseSchema(ReleaseManifestSchema, manifest); return manifest;
}
export async function verifyManifest(manifest, archive, dir, expected) {
  assertReleaseSchema(ReleaseManifestSchema, manifest);
  if (manifest.schemaVersion !== 2) throw new Error("Historical manifest cannot authorize a stable functional release");
  if (JSON.stringify(manifest.subject) !== JSON.stringify(expected)) throw new Error("Manifest source identity mismatch");
  const data = await readFile(archive);
  if (manifest.artifact.integrity !== integrity(data) || manifest.artifact.sha256 !== sha256(data)) throw new Error("Tarball integrity mismatch");
  const reports = [];
  const files = [...manifest.reports, ...manifest.references];
  if (new Set(files.map(r => r.file)).size !== files.length) throw new Error("Duplicate evidence file");
  for (const r of files) {
    const path = resolve(dir, r.file), rel = relative(resolve(dir), path);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Invalid report path");
    const bytes = await readFile(path);
    if (sha256(bytes) !== r.sha256) throw new Error("Report integrity mismatch");
    reports.push({ file: r.file, sha256: r.sha256, value: JSON.parse(bytes) });
  }
  const selected = await validateReportFiles(reports, expected, Date.now(), integrity(data), dir);
  if (JSON.stringify(selected.required.map(r => r.file).sort()) !== JSON.stringify(manifest.reports.map(r => r.file).sort())) throw new Error("Required evidence was relabeled as reference");
  return true;
}
export async function registryState(name, version, expectedIntegrity, fetcher = fetch) {
  const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`);
  if (response.status === 404) return "absent";
  if (!response.ok) throw new Error(`Registry read failed: HTTP ${response.status}`);
  const data = await response.json();
  if (data.dist?.integrity !== expectedIntegrity) throw new Error("Version exists with a different artifact");
  return "identical";
}

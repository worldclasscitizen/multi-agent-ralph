import { readFile } from "node:fs/promises";
import { join, basename, posix } from "node:path";
import ts from "typescript";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertReleaseSchema, EvidenceReuseSchema, VerificationReportV1Schema } from "../../dist/release/schema.js";

const exec = promisify(execFile);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const normalize = bytes => Buffer.from(bytes).includes(0) ? bytes : Buffer.from(bytes).toString("utf8").replaceAll("\r\n", "\n");
export const PROVIDER_CHECKS = ["structured_output", "file_change_and_deterministic_verification", "fresh_request_isolation", "cancel_and_await_close"];
async function git(root, args) { return (await exec("git", args, { cwd: root, encoding: "buffer", maxBuffer: 20_000_000, windowsHide: true })).stdout; }
// Traverse the adapter and fixture helper imports, including type dependencies.
// Contract/graph prompting is exercised by the separate end-to-end protocol.
// Bookkeeping and report serialization are covered by deterministic tests.
export async function providerFiles(root, ref) {
  if (ref && !/^[a-f0-9]{40}$/.test(ref)) throw new Error("Invalid evidence source commit");
  const load = async path => normalize(ref ? await git(root, ["show", `${ref}:${path}`]) : await readFile(join(root, path)));
  const files = new Map();
  async function visit(path) {
    if (files.has(path)) return;
    if (!path.startsWith("src/") || path.includes("..")) throw new Error("Unexpected provider dependency path");
    const source = await load(path);
    files.set(path, hash(source));
    const syntax = ts.createSourceFile(path, String(source), ts.ScriptTarget.Latest, true);
    const dependencies = [];
    function walk(node) {
      let specifier;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0];
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(".")) dependencies.push(posix.normalize(posix.join(posix.dirname(path), specifier.text)).replace(/\.js$/, ".ts"));
      ts.forEachChild(node, walk);
    }
    walk(syntax);
    for (const dependency of dependencies) await visit(dependency);
  }
  await visit("src/providers/cli.ts");
  await visit("src/workspace/manager.ts");
  for (const path of ["scripts/provider-conformance.mjs", "scripts/lib/live-budget.mjs", "package-lock.json"]) files.set(path, hash(await load(path)));
  return [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, sha256]) => ({ path, sha256 }));
}
function assertOriginal(report, observed) {
  assertReleaseSchema(VerificationReportV1Schema, report);
  if (report.kind !== "provider" || report.status !== "pass" || report.checks.some(c => !c.passed) || PROVIDER_CHECKS.some(name => !report.checks.some(c => c.name === name && c.passed))) throw new Error("Only complete, passing provider evidence can be reused");
  const recorded = { adapter: report.details.adapter, model: report.details.model, cliVersion: report.details.cliVersion, platform: report.runner.platform, node: report.runner.node };
  if (JSON.stringify(recorded) !== JSON.stringify(observed)) throw new Error("Provider environment changed");
}
export async function createEvidenceReuse(root, originalPath, observed) {
  const bytes = await readFile(originalPath), original = JSON.parse(bytes);
  assertOriginal(original, observed);
  const previous = await providerFiles(root, original.subject.sourceCommit), current = await providerFiles(root);
  if (JSON.stringify(previous) !== JSON.stringify(current)) throw new Error("Provider execution protocol changed; new live evidence required");
  const reuse = { schemaVersion: 1, protocol: "codex-conformance-v1", originalFile: basename(originalPath), originalSha256: hash(bytes), originalCheckedAt: original.checkedAt, sourceCommit: original.subject.sourceCommit, sourceFiles: previous, observed, verifiedAt: new Date().toISOString() };
  assertReleaseSchema(EvidenceReuseSchema, reuse);
  return reuse;
}
export async function verifyEvidenceReuse(report, directory, root = process.cwd()) {
  if (!report.reuse) return;
  const reuse = report.reuse;
  assertReleaseSchema(EvidenceReuseSchema, reuse);
  const bytes = await readFile(join(directory, reuse.originalFile));
  if (hash(bytes) !== reuse.originalSha256) throw new Error("Original provider report integrity mismatch");
  const original = JSON.parse(bytes);
  assertOriginal(original, reuse.observed);
  if (report.kind !== "provider" || report.schemaVersion !== 2 || original.checkedAt !== report.checkedAt || original.checkedAt !== reuse.originalCheckedAt || original.subject.sourceCommit !== reuse.sourceCommit || JSON.stringify(original.checks) !== JSON.stringify(report.checks) || JSON.stringify(original.details) !== JSON.stringify(report.details) || JSON.stringify(original.runner) !== JSON.stringify(report.runner)) throw new Error("Reused evidence changed its original result or scope");
  const previous = await providerFiles(root, reuse.sourceCommit), current = await providerFiles(root);
  if (JSON.stringify(previous) !== JSON.stringify(reuse.sourceFiles) || JSON.stringify(previous) !== JSON.stringify(current)) throw new Error("Provider protocol identity mismatch");
}

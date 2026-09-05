import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { verifyEvidenceReuse } from "./lib/evidence-reuse.mjs";
import { assertReleaseSchema, VerificationReportSchema } from "../dist/release/schema.js";
import { json, sha256, subject } from "./lib/release.mjs";
const reportPath = process.argv[2];
let records = await json("assets/provider-verification.json");
if (reportPath) {
  const report = await json(reportPath), current = await subject();
  assertReleaseSchema(VerificationReportSchema, report);
  await verifyEvidenceReuse(report, dirname(reportPath));
  if (report.kind !== "provider" || report.status !== "pass" || report.checks.some((c) => !c.passed) || report.subject.runtimeDigest !== current.runtimeDigest || report.subject.testDigest !== current.testDigest) throw new Error("Provider evidence does not qualify for this runtime");
  records = [{ schemaVersion: 1, adapter: report.details.adapter, model: report.details.model, cliVersion: report.details.cliVersion,
    platform: report.runner.platform, node: report.runner.node, checkedAt: report.checkedAt, runtimeDigest: report.subject.runtimeDigest,
    testDigest: report.subject.testDigest, reportDigest: sha256(await readFile(reportPath)), features: report.checks.map((c) => c.name), support: "verified" }];
  await writeFile("assets/provider-verification.json", JSON.stringify(records, null, 2) + "\n");
}
for (const file of ["README.md", "README.ko.md"]) {
  const text = await readFile(file, "utf8");
  const rows = records.length ? records.map((r) => `| ${r.adapter} / ${r.model} | verified | ${r.cliVersion} · ${r.platform} · ${r.node} · ${r.checkedAt.slice(0, 10)} |`).join("\n") : "| Codex | compatible | Live release verification pending |";
  const table = `<!-- provider-verification:start -->\n| Connection / model | Support | Verified environment |\n|---|---|---|\n${rows}\n| Claude Code, Gemini CLI | compatible | Protocol tests; no current live verification |\n| OpenAI, Anthropic, Gemini, DeepSeek, GLM APIs | compatible | Protocol tests; no current live verification |\n| Antigravity | experimental | Requires a working automation interface |\n| Other compatible endpoints | compatible | No live verification |\n<!-- provider-verification:end -->`;
  if (!text.includes("<!-- provider-verification:start -->")) throw new Error(`Missing generated support block: ${file}`);
  await writeFile(file, text.replace(/<!-- provider-verification:start -->[\s\S]*?<!-- provider-verification:end -->/, table));
}

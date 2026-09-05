import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import {
  CodexBuiltinAdapter,
  ClaudeBuiltinAdapter,
  GeminiCliBuiltinAdapter,
} from "../dist/providers/cli.js";
import { git } from "../dist/workspace/manager.js";
import { parseJsonObject, redact } from "../dist/util.js";
import { LiveBudget } from "./lib/live-budget.mjs";

const args = process.argv.slice(2),
  value = (key) => args[args.indexOf(key) + 1];
if (args.includes("--help") || !args.includes("--live")) {
  console.log(
    "Opt-in live smoke: node scripts/provider-conformance.mjs --live --provider codex|claude|gemini --model <observed-model-id> --output <report.json>\nMakes bounded real provider calls in temporary Git fixtures. Full release conformance additionally requires failure injection and service-specific review.",
  );
  process.exit(0);
}
const provider = value("--provider"),
  model = value("--model"),
  output = value("--output");
const Adapter = {
  codex: CodexBuiltinAdapter,
  claude: ClaudeBuiltinAdapter,
  gemini: GeminiCliBuiltinAdapter,
}[provider];
if (!Adapter || !args.includes("--model") || !args.includes("--output") || !args.includes("--budget"))
  throw new Error("Provider, model, output and the persistent release budget path are required");
const adapter = new Adapter(),
  report = {
    schemaVersion: 1,
    kind: "live-smoke",
    provider,
    model,
    platform: process.platform,
    node: process.version,
    checkedAt: new Date().toISOString(),
    checks: [],
    support: "compatible",
  };
const budget = new LiveBudget(resolve(value("--budget")));
const invoke = adapter.invoke.bind(adapter);
adapter.invoke = (request, signal) => budget.invoke(`conformance/${request.nodeId}`, bounded => invoke(request, bounded), signal);
const save = async () => {
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
};
const detection = await adapter.detect(),
  auth = await adapter.authStatus();
report.cliVersion = detection.version ?? null;
report.authentication = auth.status;
if (auth.status !== "authenticated") {
  report.checks.push({ name: "authentication", status: "blocked" });
  await save();
  process.exit(10);
}
const root = await mkdtemp(join(tmpdir(), "ralph-live-conformance-"));
await git(root, ["init"]);
await git(root, ["config", "user.name", "Conformance"]);
await git(root, ["config", "user.email", "conformance@localhost"]);
await writeFile(
  join(root, "README.md"),
  "Disposable provider conformance fixture.\n",
);
await git(root, ["add", "."]);
await git(root, ["commit", "-m", "base"]);
const request = {
  runId: "conformance",
  nodeId: "probe",
  generation: 0,
  role: "contractPlanner",
  projectRoot: root,
  model: {
    connectionId: provider,
    provider,
    modelId: model,
    displayName: model,
    mode: "builtin",
    reasoningEffort: "low",
  },
};
async function check(name, fn) {
  if (report.credentialBlocked && name !== "cancel_and_await_close") {
    report.checks.push({
      name,
      status: "blocked",
      reason: "Expired provider credential",
    });
    await save();
    return;
  }
  const start = Date.now();
  try {
    const evidence = await fn();
    report.checks.push({
      name,
      status: "pass",
      durationMs: Date.now() - start,
      ...evidence,
    });
  } catch (e) {
    if (/authenticate|oauth.*expired/i.test(String(e)))
      report.credentialBlocked = true;
    report.checks.push({
      name,
      status: "failed",
      durationMs: Date.now() - start,
      error: redact(String(e)),
    });
  }
  await save();
  console.log(JSON.stringify(report.checks.at(-1)));
}
await check("structured_output", async () => {
  const r = await adapter.invoke(
    {
      ...request,
      prompt:
        'Return only this JSON object: {"ok":true,"scope":["conformance.txt"]}. Do not use tools or change files.',
    },
    AbortSignal.timeout(60000),
  );
  if (r.exitCode !== 0 || parseJsonObject(r.text).ok !== true)
    throw new Error(r.error?.message ?? "Invalid structured output");
  return { usage: r.usage ?? null };
});
await check("file_change_and_deterministic_verification", async () => {
  const r = await adapter.invoke(
    {
      ...request,
      role: "worker",
      nodeId: "worker",
      readPaths: ["**"],
      writePaths: ["conformance.txt"],
      prompt:
        "In this disposable Git fixture, create only conformance.txt with exactly three UTF-8 bytes: 111, 107, 10 (the letters ok and a final LF newline). Verify the bytes before reporting completion. Do not modify any other file, run network tools, commit, push or install anything. Then report completion briefly.",
    },
    AbortSignal.timeout(90000),
  );
  if (r.exitCode !== 0) throw new Error(r.error?.message ?? "Worker failed");
  if (
    (await readFile(join(root, "conformance.txt"), "utf8")).replaceAll(
      "\r\n",
      "\n",
    ) !== "ok\n"
  )
    throw new Error("Artifact content mismatch");
  const files = await git(root, ["status", "--porcelain"]);
  if (
    files
      .split(/\r?\n/)
      .filter(Boolean)
      .some((l) => !l.endsWith("conformance.txt"))
  )
    throw new Error("Worker exceeded scope");
  return { usage: r.usage ?? null, artifact: "conformance.txt" };
});
await check("fresh_request_isolation", async () => {
  const r = await adapter.invoke(
    {
      ...request,
      nodeId: "isolated",
      prompt:
        'This is an independent request with no session ID. Return only JSON {"marker":"independent-2"}. Do not use tools.',
    },
    AbortSignal.timeout(60000),
  );
  if (r.exitCode !== 0 || parseJsonObject(r.text).marker !== "independent-2")
    throw new Error(r.error?.message ?? "Isolation marker mismatch");
  return { usage: r.usage ?? null };
});
await check("cancel_and_await_close", async () => {
  const controller = new AbortController();
  const pending = adapter.invoke(
    {
      ...request,
      nodeId: "cancel",
      prompt:
        "Read-only cancellation probe. Do not change files. Return a short hello.",
    },
    controller.signal,
  );
  const timer = setTimeout(
    () => controller.abort(new Error("Conformance cancellation")),
    250,
  );
  let cancelled = false;
  try {
    await pending;
  } catch {
    cancelled = true;
  } finally {
    clearTimeout(timer);
  }
  if (!cancelled)
    throw new Error("Probe finished before cancellation was observed");
  return { confirmed: "adapter returned after subprocess close" };
});
report.allSmokeChecksPassed = report.checks.every((c) => c.status === "pass");
await save();
if (!report.allSmokeChecksPassed) process.exitCode = 1;

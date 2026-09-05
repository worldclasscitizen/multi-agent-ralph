import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

if (!process.argv.includes("--init-key")) throw new Error("Explicit --init-key required; never run in a package build");
const keyPath = join(homedir(), ".config", "ralph", "release-keys", "catalog-v2.pem");
await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
let privateKey;
try { privateKey = createPrivateKey(await readFile(keyPath)); }
catch (e) {
  if (e.code !== "ENOENT") throw e;
  privateKey = generateKeyPairSync("ed25519").privateKey;
  await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
}
if (process.platform === "win32") {
  const sid = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).match(/S-1-[0-9-]+/)?.[0];
  if (!sid) throw new Error("Cannot resolve current Windows account SID");
  execFileSync("icacls", [keyPath, "/inheritance:r", "/grant:r", `*${sid}:(F)`], { stdio: "pipe", windowsHide: true });
}
const publicKey = createPublicKey(privateKey), pem = publicKey.export({ type: "spki", format: "pem" });
const keyId = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
await writeFile("src/catalog-key.ts", `// Public trust anchor. Private signing material stays outside this repository.\nexport const CATALOG_KEY_ID = ${JSON.stringify(keyId)};\nexport const CATALOG_PUBLIC_KEY_PEM = ${JSON.stringify(pem)};\n`);
const sources = {
  codex: "https://learn.chatgpt.com/docs/models",
  openai: "https://developers.openai.com/api/docs/models/gpt-5.4-mini",
  claude: "https://platform.claude.com/docs/en/models/overview",
  gemini: "https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash",
  deepseek: "https://api-docs.deepseek.com/updates/",
  glm: "https://docs.z.ai/guides/llm/glm-5",
};
const definitions = [
  ["openai", "codex-builtin", "gpt-5.6-luna", "codex", false],
  ["openai", "codex-builtin", "gpt-5.6-terra", "codex", false],
  ["openai", "codex-builtin", "gpt-5.6-sol", "codex", false],
  ["openai", "openai-api", "gpt-5.4-mini", "openai", true],
  ["anthropic", "claude-code-builtin", "claude-sonnet-5", "claude", false],
  ["anthropic", "anthropic-api", "claude-sonnet-5", "claude", true],
  ["google", "gemini-cli-builtin", "gemini-2.5-flash", "gemini", false],
  ["google", "gemini-api", "gemini-2.5-flash", "gemini", true],
  ["deepseek", "deepseek-api", "deepseek-v4-pro", "deepseek", false],
  ["zai", "zai-general-api", "glm-5", "glm", false],
  ["zai", "zai-coding-api", "glm-5", "glm", false],
];
const tasks = ["planning_architecture", "frontend_visual", "backend_core", "tdd_debugging", "static_review", "delivery_evidence"];
const catalog = { schemaVersion: 2, keyId, version: 3, generatedAt: "2026-09-05T00:00:00.000Z", models: definitions.map(([provider, adapter, modelId, source, vision]) => ({
  provider, adapter, modelId, displayName: modelId, qualityTier: "unrated", checkedAt: "2026-09-05T00:00:00.000Z", expiresAt: "2027-03-05T00:00:00.000Z",
  capabilities: { reasoning: null, coding: null, structuredOutput: true, vision, toolUse: true, longContext: false },
  taskAffinity: Object.fromEntries(tasks.map((t) => [t, null])), costTier: null, latencyTier: null, reliabilityBaseline: null,
  supportedEfforts: ["low", "medium", "high"], recommendedEffort: "low",
  evidence: [{ source: sources[source], checkedAt: "2026-09-05" }],
})) };
await writeFile("assets/catalog-v2.json", JSON.stringify(catalog, null, 2) + "\n");
await writeFile("assets/catalog-v2.sig", sign(null, Buffer.from(JSON.stringify(catalog)), privateKey).toString("base64") + "\n");
console.log(JSON.stringify({ keyId, publicKey: pem, privateKeyStoredOutsideRepository: true, legacyAssetsUnchanged: true }));

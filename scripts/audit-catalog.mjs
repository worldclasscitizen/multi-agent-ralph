import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { loadCatalog, verifyCatalog, CATALOG_KEY_ID } from "../dist/catalog.js";
import { atomicJson, report, sha256, BASELINE } from "./lib/release.mjs";
const current = await loadCatalog(), legacy = JSON.parse(await readFile("assets/catalog.json", "utf8"));
const original = JSON.parse(execFileSync("git", ["show", `${BASELINE}:assets/catalog.json`], { encoding: "utf8" }));
const hosts = new Set(["learn.chatgpt.com", "developers.openai.com", "platform.claude.com", "ai.google.dev", "api-docs.deepseek.com", "docs.z.ai"]);
const checks = [
  { name: "v2 signature and trust anchor", passed: current.schemaVersion === 2 && current.keyId === CATALOG_KEY_ID && verifyCatalog(current, await readFile("assets/catalog-v2.sig", "utf8")) },
  { name: "legacy content and signature retained", passed: JSON.stringify(legacy) === JSON.stringify(original) && verifyCatalog(legacy, await readFile("assets/catalog.sig", "utf8")) },
  ...current.models.map((m) => ({ name: `${m.adapter}/${m.modelId}`, passed: m.qualityTier === "unrated" && m.capabilities.reasoning === null && m.capabilities.coding === null && Object.values(m.taskAffinity).every((v) => v === null) && m.evidence.every((e) => hosts.has(new URL(e.source).hostname)) })),
];
await atomicJson(resolve(".release/evidence/catalog.json"), await report("catalog", checks, { keyId: CATALOG_KEY_ID, catalogVersion: current.version, legacyContentDigest: sha256(JSON.stringify(legacy)), sources: [...new Set(current.models.flatMap((m) => m.evidence.map((e) => e.source)))] }));
if (checks.some((c) => !c.passed)) throw new Error("Catalog audit failed");
console.log("Signed v2 catalog and preserved legacy channel verified; numerical quality is unrated.");

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { json, integrity, sha256, report, atomicJson } from "./lib/release.mjs";
import { verifyCatalog } from "../dist/catalog.js";
const exec = promisify(execFile), registryOnly = process.argv.includes("--registry-only");
const manifest = await json(".release/evidence/manifest.json");
const checks = [];
const fetchJson = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`); return r.json(); };
for (const version of ["0.3.0", "latest"]) {
  const pkg = await fetchJson(`https://registry.npmjs.org/@worldclasscitizen%2Fralph/${version}`);
  if (pkg.version !== "0.3.0" || pkg.dist.integrity !== manifest.artifact.integrity) throw new Error("Registry version/integrity mismatch");
  const response = await fetch(pkg.dist.tarball);
  if (!response.ok || integrity(Buffer.from(await response.arrayBuffer())) !== manifest.artifact.integrity) throw new Error("Registry tarball bytes differ");
  checks.push({ name: `registry ${version}: version and exact tarball`, passed: true });
}
if (!registryOnly) {
  const release = JSON.parse((await exec("gh", ["api", "repos/worldclasscitizen/Ralph/releases/tags/v0.3.0"])).stdout);
  if (release.draft || release.prerelease || release.tag_name !== "v0.3.0" || !release.immutable) throw new Error("Expected public immutable stable release");
  const tag = (await exec("git", ["rev-parse", "v0.3.0^{commit}"])).stdout.trim();
  if (tag !== manifest.subject.sourceCommit) throw new Error("Release tag commit mismatch");
  const latest = await fetchJson("https://api.github.com/repos/worldclasscitizen/Ralph/releases/latest");
  if (latest.id !== release.id) throw new Error("Latest GitHub release mismatch");
  for (const file of ["catalog.json", "catalog.sig", "catalog-v2.json", "catalog-v2.sig", manifest.artifact.file, ...manifest.reports.map(r => r.file), ...(manifest.references ?? []).map(r => r.file), "manifest.json", "installation.json", "SHA256SUMS.txt"]) {
    const asset = release.assets.find(a => a.name === file);
    if (!asset) throw new Error(`Missing release asset: ${file}`);
    const response = await fetch(asset.browser_download_url);
    if (!response.ok) throw new Error(`Cannot download ${file}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const local = file === "SHA256SUMS.txt" ? ".release/SHA256SUMS.txt" : file.startsWith("catalog") ? `assets/${file}` : file.endsWith(".tgz") ? `.release/package/${file}` : `.release/evidence/${file}`;
    if (sha256(bytes) !== sha256(await readFile(local))) throw new Error(`Release asset mismatch: ${file}`);
  }
  for (const name of ["catalog", "catalog-v2"]) if (!verifyCatalog(await json(`assets/${name}.json`), await readFile(`assets/${name}.sig`, "utf8"))) throw new Error("Catalog signature mismatch");
  checks.push({ name: "immutable GitHub release, exact commit and assets", passed: true });
}
await atomicJson(`.release/evidence/${registryOnly ? "installation" : "post-release"}.json`, await report("installation", checks, { artifactIntegrity: manifest.artifact.integrity, installedSmoke: "Preceding workflow steps installed exact and default versions, initialized state, served UI and integrated a mock graph" }));
console.log(checks.map(c => c.name).join("\n"));

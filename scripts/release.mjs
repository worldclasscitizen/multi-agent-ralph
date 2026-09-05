import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile } from "node:fs/promises";
import { atomicJson, json, report, createManifest, verifyManifest, subject, registryState, integrity } from "./lib/release.mjs";
const exec = promisify(execFile);
const args = process.argv.slice(2), command = args[0];
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const dir = resolve(value("--evidence", ".release/evidence"));
const archive = value("--archive");
if (command === "record-ci") {
  const checks = ["install", "build", "types", "tests", "docs", "installed-package"].map((name) => ({ name, passed: true }));
  if (!process.env.GITHUB_RUN_ID) throw new Error("CI report requires a GitHub workflow run");
  const archives = (await readdir(".release/package")).filter((f) => f.endsWith(".tgz"));
  if (archives.length !== 1) throw new Error("Expected the single CI-tested archive");
  await atomicJson(join(dir, `ci-${process.platform}-${process.versions.node.split(".")[0]}.json`), await report("ci", checks, { artifactIntegrity: integrity(await readFile(join(".release/package", archives[0]))) }));
} else if (command === "manifest") {
  if (!archive) throw new Error("--archive required");
  const result = await createManifest(resolve(archive), dir);
  await atomicJson(join(dir, "manifest.json"), result);
  console.log(result.artifact.integrity);
} else if (command === "verify") {
  if (!archive) throw new Error("--archive required");
  await verifyManifest(await json(join(dir, "manifest.json")), resolve(archive), dir, await subject());
  console.log("Manifest, source, reports and artifact verified");
} else if (command === "publish") {
  if (process.env.GITHUB_REF !== "refs/heads/main" || !process.env.ACTIONS_ID_TOKEN_REQUEST_URL || process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") throw new Error("Publishing requires the main-branch OIDC release workflow");
  if (!archive) throw new Error("--archive required");
  const target = await subject(), manifest = await json(join(dir, "manifest.json"));
  if (target.version !== "0.3.0" || target.sourceCommit !== process.env.RELEASE_SHA) throw new Error("Release version/commit mismatch");
  await verifyManifest(manifest, resolve(archive), dir, target);
  const state = await registryState("@worldclasscitizen/ralph", target.version, manifest.artifact.integrity);
  if (state === "identical") console.log("Identical version already published; continuing verification");
  else {
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error("Run via npm run release -- publish ...");
    await exec(process.execPath, [npm, "publish", resolve(archive), "--ignore-scripts", "--access", "public", "--tag", "latest"], { maxBuffer: 2_000_000 });
  }
  if (await registryState("@worldclasscitizen/ralph", target.version, manifest.artifact.integrity) !== "identical") throw new Error("Published artifact not visible");
} else {
  console.log("release.mjs record-ci | manifest | verify | publish --evidence <directory> --archive <tgz>");
  if (command) process.exitCode = 2;
}

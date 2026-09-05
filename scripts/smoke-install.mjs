import { execFile } from "node:child_process";
import { mkdtemp, readdir, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const npmCli = process.env.npm_execpath;
const runNpm = async (args, options) =>
  npmCli
    ? await exec(process.execPath, [npmCli, ...args], options)
    : await exec("npm", args, options);
const source = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const expectedVersion = value("--expected-version") ?? JSON.parse(await readFile(join(source, "package.json"), "utf8")).version;
const temp = await mkdtemp(join(tmpdir(), "ralph-pack-smoke-"));
const project = join(temp, "project");
await import("node:fs/promises").then(({ mkdir }) => mkdir(project));

let archive = value("--archive");
if (value("--archive-dir")) {
  const dir = resolve(value("--archive-dir"));
  const files = (await readdir(dir)).filter((name) => name.endsWith(".tgz"));
  if (files.length !== 1) throw new Error("Expected exactly one release archive");
  archive = join(dir, files[0]);
}
if (!archive && !value("--package")) {
  await runNpm(["pack", "--pack-destination", temp], { cwd: source });
  archive = join(temp, (await readdir(temp)).find((name) => name.endsWith(".tgz")) ?? "missing.tgz");
}
archive = value("--package") ?? resolve(archive);
if (!archive) throw new Error("npm pack archive가 생성되지 않았습니다.");
await runNpm(["init", "-y"], { cwd: project });
await runNpm(["install", archive], { cwd: project });
await exec("git", ["init"], { cwd: project });
await exec("git", ["config", "user.email", "ralph@example.invalid"], {
  cwd: project,
});
await exec("git", ["config", "user.name", "Ralph Smoke"], { cwd: project });
await writeFile(join(project, ".gitignore"), "node_modules/\n", "utf8");
await exec("git", ["add", "package.json", "package-lock.json", ".gitignore"], {
  cwd: project,
});
await exec("git", ["commit", "-m", "baseline"], { cwd: project });
const binary = join(
  project,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "ralph.cmd" : "ralph",
);
await stat(binary);
const cli = join(
  project,
  "node_modules",
  "@worldclasscitizen",
  "ralph",
  "dist",
  "cli.js",
);
const version = await exec(process.execPath, [cli, "--version"], {
  cwd: project,
});
if (version.stdout.trim() !== expectedVersion)
  throw new Error("설치된 binary 버전이 올바르지 않습니다.");
await exec(process.execPath, [cli, "init", "--project", project, "--json"], {
  cwd: temp,
  env: { ...process.env, RALPH_CATALOG_URL: "http://127.0.0.1:1/catalog.json" },
});
await stat(join(project, ".git", "ralph", "config.json"));
for (const forbidden of [".ralph", ".antigravity", "PROMPT.md"]) {
  try {
    await stat(join(project, forbidden));
    throw new Error(
      `프로젝트 루트에 금지된 제어 파일이 생성되었습니다: ${forbidden}`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("프로젝트 루트"))
      throw error;
  }
}
process.stdout.write(
  `OK: npm archive ${archive} 설치와 Git 내부 상태 초기화를 확인했습니다.\n`,
);

const installed = join(project, "node_modules", "@worldclasscitizen", "ralph");
for (const asset of ["app.js", "styles.css", "elk.bundled.js", "index.html"])
  await stat(join(installed, "assets", "dashboard", asset));
const { startDashboard } = await import(
  pathToFileURL(join(installed, "dist", "dashboard.js")).href
);
const dashboard = await startDashboard(project, { port: 0 });
try {
  const html = await fetch(dashboard.url).then((r) => r.text());
  if (!html.includes("app.js"))
    throw new Error("Packaged dashboard entry missing");
  const script = await fetch(dashboard.url + "app.js");
  if (!script.ok || (await script.text()).length < 1000)
    throw new Error("Packaged dashboard script missing");
} finally {
  dashboard.server.closeAllConnections();
  await new Promise((r) => dashboard.server.close(r));
}
console.log(
  "OK: Installed package serves its bundled dashboard without frontend dependencies",
);

const library = await import(pathToFileURL(join(installed, "dist/index.js")).href);
const { saveConfig } = await import(pathToFileURL(join(installed, "dist/state.js")).href);
const mock = join(temp, "mock-agent.mjs");
await writeFile(mock, await readFile(join(source, "tests/fixtures/mock-agent.mjs")));
const config = JSON.parse(await readFile(join(project, ".git/ralph/config.json"), "utf8"));
const route = { connectionId: "installed-mock", provider: "mock", modelId: "mock-1", displayName: "Installed fixture", score: 0, source: "override" };
config.connections = [{ id: route.connectionId, adapter: "generic-process", provider: "mock", enabled: true, mode: "process", command: [process.execPath, mock] }];
config.routes = Object.fromEntries(["backend_core", "critic", "worker", "adjudicator", "contractPlanner"].map(role => [role, [route]]));
config.routePolicies = {}; config.overrides = {};
config.verifierCommands = ["node -e \"require('node:assert/strict').equal(require('node:fs').readFileSync('ralph-smoke.txt','utf8').trim(),'ok')\"", "git diff --check"];
await saveConfig(project, config);
const contract = library.validateContract({ taskType: "backend_core", goal: "Create installed smoke artifact", include: ["ralph-smoke.txt"], exclude: [".git/**"], acceptanceCriteria: ["Artifact contains ok"], requiredArtifacts: ["ralph-smoke.txt"], verifierCommands: config.verifierCommands }, project);
const plan = await library.planRun(project, contract.goal, { contract, mode: "single" });
const state = await library.startRun(library.approvePlan(plan));
if (state.status !== "completed") throw new Error(`Installed graph failed: ${state.message}`);
if ((await readFile(join(project, "ralph-smoke.txt"), "utf8")).trim() !== "ok") throw new Error("Installed artifact mismatch");
console.log("OK: Installed public API completed, verified and integrated a mock graph without model calls");

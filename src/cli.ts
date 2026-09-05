#!/usr/bin/env node
import { graphCli } from "./cli-graph.js";
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  catalogDiff,
  catalogStatus,
  loadCatalog,
  maybeRefreshCatalog,
  previewCatalogUpdate,
  updateCatalog,
} from "./catalog.js";
import {
  compareBenchmarkResults,
  loadBenchmarkResult,
  recordHumanCalibration,
  resolveSuitePath,
  runBenchmark,
  setBenchmarkBaseline,
} from "./benchmark.js";
import { capacityForProject } from "./capacity.js";
import {
  createProjectConfig,
  detectConnections,
  refreshProjectConfig,
  setPreset,
} from "./config.js";
import { approveContract, validateContract } from "./contracts.js";
import {
  getCredential,
  removeCredential,
  setCredential,
} from "./credentials.js";
import { startDashboard } from "./dashboard.js";
import { findGitRoot, gitStatus, checkpoint } from "./git.js";
import {
  installIntegrations,
  integrationStatus,
  uninstallIntegrations,
} from "./integrations.js";
import { cleanupLegacy, migrateLegacy } from "./migrate.js";
import { draftContract, executeContract, resumeRun } from "./orchestrator.js";
import { classifyRisk, deterministicRouteDecision } from "./policy.js";
import { createAdapter } from "./providers/index.js";
import { probeProvider } from "./gateway/capabilities.js";
import { registerProject } from "./registry.js";
import { buildRoutes, explainRoutes } from "./router.js";
import {
  activeRun,
  deleteRun,
  ensureState,
  listRuns,
  loadConfig,
  loadContract,
  readEvents,
  readLock,
  removeLock,
  requestStop,
  saveConfig,
  saveContract,
  saveRun,
  statePaths,
  pidIsAlive,
} from "./state.js";
import type {
  AgentRole,
  ExecutionProfile,
  ProjectConfig,
  RouteEntry,
  RunState,
  TaskContract,
  TaskType,
} from "./types.js";
import {
  formatError,
  now,
  RalphError,
  readJson,
  runCommand,
  writeJson,
} from "./util.js";
import { readCoverageSummary } from "./verifier.js";

const VERSION = "0.3.0";
const argv = process.argv.slice(2);

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new RalphError(`${name} 값이 필요합니다.`, "invalid_argument", 2);
  args.splice(index, 2);
  return value;
}

function takeOptions(args: string[], name: string): string[] {
  const values: string[] = [];
  while (args.includes(name)) values.push(takeOption(args, name)!);
  return values;
}

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function projectRoot(args: string[]): Promise<string> {
  const option = takeOption(args, "--project");
  if (option && !isAbsolute(option))
    throw new RalphError(
      "--project에는 절대 경로가 필요합니다.",
      "invalid_project_path",
      2,
    );
  return await findGitRoot(option ?? process.cwd());
}

function human(message: string): void {
  process.stderr.write(`${message}\n`);
}
function print(value: unknown, asJson = false): void {
  process.stdout.write(
    asJson ? `${JSON.stringify(value, null, 2)}\n` : `${String(value)}\n`,
  );
}

async function confirm(question: string): Promise<boolean> {
  if (!input.isTTY)
    throw new RalphError(
      "비대화형 실행에서는 명시적인 --yes 승인이 필요합니다.",
      "approval_required",
      10,
    );
  const rl = createInterface({ input, output });
  try {
    return /^(y|yes|예|승인)$/i.test(
      (await rl.question(`${question} [y/N] `)).trim(),
    );
  } finally {
    rl.close();
  }
}

function showContract(contract: TaskContract, config: ProjectConfig): void {
  human("\n작업 계약");
  human(`- 유형: ${contract.taskType}`);
  human(`- 목표: ${contract.goal}`);
  human(`- 프로필: ${contract.executionProfile}`);
  human(`- 위험도: ${contract.riskTier ?? classifyRisk(contract)}`);
  human(`- 포함: ${contract.include.join(", ") || "지정 없음"}`);
  human(`- 제외: ${contract.exclude.join(", ") || "지정 없음"}`);
  human(`- 완료 기준: ${contract.acceptanceCriteria.join(" / ")}`);
  human(
    `- 검증: ${contract.verifierCommands.join(" / ") || config.verifierCommands.join(" / ")}`,
  );
  const chain = config.routes[contract.taskType];
  human(
    `- Worker 경로: ${chain.map((item) => `${item.displayName} (${item.reasoningEffort})`).join(" → ") || "실행 경로 없음"}`,
  );
  const degraded = [
    ...new Set(chain.flatMap((item) => item.degradedCapabilities ?? [])),
  ];
  if (degraded.length)
    human(
      `- 기능 저하 경고: 연결된 모델에 ${degraded.join(", ")} capability가 없어 해당 검증은 제한됩니다.`,
    );
  if (contract.initialRouteDecision)
    human(
      `- 승인 시점 선택: ${contract.initialRouteDecision.displayName} (${contract.initialRouteDecision.reasoningEffort}, ${contract.initialRouteDecision.sessionPolicy})`,
    );
  human("");
}

async function commandInit(args: string[]): Promise<void> {
  const root = await projectRoot(args);
  const preset = (takeOption(args, "--preset") ??
    "balanced") as ExecutionProfile;
  const asJson = takeFlag(args, "--json");
  if (!["balanced", "quality", "fast", "budget"].includes(preset))
    throw new RalphError(
      "preset은 balanced, quality, fast, budget 중 하나입니다.",
      "invalid_argument",
      2,
    );
  await maybeRefreshCatalog();
  const config = await createProjectConfig(root, preset);
  await registerProject(root);
  human(
    `Ralph 상태를 Git 내부 경로에 초기화했습니다: ${(await statePaths(root)).root}`,
  );
  print(
    {
      projectRoot: root,
      preset,
      connections: config.connections,
      routes: explainRoutes(config),
    },
    asJson,
  );
}

async function commandDoctor(args: string[]): Promise<void> {
  const offline = takeFlag(args, "--offline");
  const fix = takeFlag(args, "--fix");
  const asJson = takeFlag(args, "--json");
  const root = await projectRoot(args);
  let config: ProjectConfig | undefined;
  let fixWarning: string | undefined;
  try {
    config = await loadConfig(root);
  } catch {
    if (fix) config = await createProjectConfig(root);
  }
  if (fix && !offline) {
    try {
      await updateCatalog();
    } catch (error) {
      fixWarning = `원격 카탈로그 갱신 실패: ${formatError(error)}. 기존 검증본을 유지합니다.`;
    }
  }
  if (fix && config) {
    config = await refreshProjectConfig(config, config.preset);
    await saveConfig(root, config);
  }
  const catalog = await catalogStatus({ offline, checkRemote: !offline });
  const connections = config?.connections ?? (await detectConnections());
  const auth: Array<Record<string, unknown>> = [];
  if (config)
    for (const connection of connections)
      auth.push({
        connection: connection.id,
        enabled: connection.enabled,
        ...(await createAdapter(connection, config).authStatus()),
      });
  const status = await gitStatus(root);
  const lock = await readLock(root);
  const staleProcess = Boolean(lock && !pidIsAlive(lock.pid));
  const nodeSupported = Number(process.versions.node.split(".")[0]) >= 22;
  const currentRouteImpact = config ? explainRoutes(config) : {};
  let routeImpact: Record<string, unknown> = { current: currentRouteImpact };
  if (
    config &&
    !offline &&
    catalog.remoteVersion &&
    catalog.remoteVersion > catalog.selectedVersion
  ) {
    try {
      const preview = await previewCatalogUpdate();
      if (preview) {
        const nextConfig = {
          ...config,
          routes: buildRoutes(
            preview,
            config.connections,
            config.preset,
            config.overrides,
          ),
          catalogVersion: preview.version,
        };
        const after = explainRoutes(nextConfig);
        routeImpact = {
          current: currentRouteImpact,
          afterCatalogUpdate: after,
          affectedChains: Object.keys(config.routes).filter(
            (key) =>
              JSON.stringify(
                (currentRouteImpact as Record<string, unknown>)[key],
              ) !== JSON.stringify(after[key]),
          ),
        };
      }
    } catch {
      // 원격 preview 실패는 진단 자체를 막지 않습니다.
    }
  }
  const result = {
    ok:
      nodeSupported &&
      Boolean(config) &&
      !status.trim() &&
      connections.length > 0 &&
      Boolean(config?.routes.contractPlanner.length) &&
      !staleProcess &&
      catalog.signatureValid,
    projectRoot: root,
    node: process.version,
    nodeSupported,
    gitClean: !status.trim(),
    staleProcess,
    configPresent: Boolean(config),
    connections,
    auth,
    catalog,
    routeImpact,
    ...(fixWarning ? { fixWarning } : {}),
  };
  if (asJson) print(result, true);
  else {
    human(`Ralph doctor: ${result.ok ? "정상" : "확인 필요"}`);
    human(
      `- Node.js: ${result.node} (${result.nodeSupported ? "지원" : "22 이상 필요"})`,
    );
    human(`- Git: ${result.gitClean ? "clean" : "변경 있음"}`);
    human(
      `- 실행 lock: ${staleProcess ? "stale · ralph recover 필요" : lock ? "실행 중" : "없음"}`,
    );
    human(`- 설정: ${result.configPresent ? "있음" : "ralph init 필요"}`);
    human(`- 카탈로그: v${catalog.selectedVersion}, ${catalog.message}`);
    if (fixWarning) human(`- 조치 경고: ${fixWarning}`);
    for (const item of auth)
      human(
        `- ${String(item.connection)}: ${String(item.status)}${item.detail ? ` · ${String(item.detail)}` : ""}`,
      );
  }
}

async function configForProfile(
  root: string,
  profile: ExecutionProfile,
): Promise<ProjectConfig> {
  const config = await loadConfig(root);
  return await refreshProjectConfig(config, profile);
}

function configForContract(
  config: ProjectConfig,
  contract: TaskContract,
): ProjectConfig {
  if (!contract.modelOverride) return config;
  const route = Object.values(config.routes)
    .flat()
    .find((item) => item.modelId === contract.modelOverride);
  if (!route)
    throw new RalphError(
      `요청한 모델 ${contract.modelOverride}을 현재 연결에서 사용할 수 없습니다.`,
      "model_unavailable",
      5,
    );
  return {
    ...config,
    routes: { ...config.routes, [contract.taskType]: [route], worker: [route] },
  };
}

async function commandDraft(args: string[]): Promise<void> {
  const root = await projectRoot(args);
  const asJson = takeFlag(args, "--json");
  await maybeRefreshCatalog();
  const request = takeFlag(args, "--stdin")
    ? await stdinText()
    : args.join(" ");
  if (!request.trim())
    throw new RalphError("작업 요청이 비어 있습니다.", "invalid_argument", 2);
  const contract = await draftContract(root, request.trim());
  const config = await configForProfile(root, contract.executionProfile);
  if (asJson) print(contract, true);
  else {
    showContract(contract, config);
    print(`계약 ID: ${contract.id}`);
  }
}

async function commandRecover(args: string[]): Promise<void> {
  const root = await projectRoot(args);
  const action = takeOption(args, "--action");
  const runId = args.find((arg) => !arg.startsWith("--"));
  const status = await gitStatus(root);
  const runs = await listRuns(root);
  const run = runId
    ? runs.find((item) => item.id === runId)
    : runs.find((item) =>
        ["interrupted_partial", "failed", "running"].includes(item.status),
      );
  if (!run) throw new RalphError("복구할 실행이 없습니다.", "run_not_found", 2);
  if (run.status === "running") {
    const lock = await readLock(root);
    if (lock && pidIsAlive(lock.pid))
      throw new RalphError(
        "실행 프로세스가 아직 살아 있습니다. 먼저 ralph stop을 사용해 주세요.",
        "run_active",
        9,
      );
    run.status = "interrupted_partial";
    run.verdict = "interrupted_partial";
    run.endedAt = now();
    await saveRun(root, run);
  }
  let choice = action;
  if (!choice) {
    human(
      `현재 변경:\n${status || "(clean)"}\n마지막 checkpoint: ${run.lastCheckpoint ?? "없음"}`,
    );
    const rl = createInterface({ input, output });
    try {
      choice = (
        await rl.question("keep, checkpoint, restore 중 하나를 입력해 주세요: ")
      ).trim();
    } finally {
      rl.close();
    }
  }
  if (choice === "keep") {
    await removeLock(root);
    human("부분 변경을 유지했습니다. 검토·커밋 후 resume해 주세요.");
    return;
  }
  if (choice === "checkpoint") {
    const commit = await checkpoint(root, {
      runId: run.id,
      task: run.taskType,
      iteration: run.iteration,
      status: "recovered_partial",
      verdict: "interrupted_partial",
    });
    await removeLock(root);
    human(`부분 변경을 ${commit.slice(0, 12)}에 checkpoint했습니다.`);
    return;
  }
  if (choice === "restore" && run.lastCheckpoint) {
    const result = await runCommand(
      "git",
      [
        "restore",
        "--source",
        run.lastCheckpoint,
        "--staged",
        "--worktree",
        "--",
        ".",
      ],
      { cwd: root },
    );
    if (result.exitCode !== 0)
      throw new RalphError(result.stderr, "recover_failed");
    await removeLock(root);
    human(
      "추적 파일을 마지막 checkpoint 상태로 복구했습니다. 추적되지 않은 파일은 안전을 위해 삭제하지 않았습니다.",
    );
    return;
  }
  throw new RalphError(
    "복구 action은 keep, checkpoint, restore 중 하나여야 합니다.",
    "invalid_argument",
    2,
  );
}

async function commandCapacity(args: string[]): Promise<void> {
  const root = await projectRoot(args);
  print(
    await capacityForProject(
      root,
      await loadConfig(root),
      takeFlag(args, "--refresh"),
    ),
    true,
  );
}

async function openUrl(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd.exe"
        : "xdg-open";
  const commandArgs =
    process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, commandArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function commandDashboard(args: string[]): Promise<void> {
  const sub = args[0] && !args[0].startsWith("--") ? args.shift() : undefined;
  const root = await projectRoot(args);
  const paths = await ensureState(root);
  const pidPath = join(paths.dashboard, "server.json");
  if (sub === "status" || sub === "stop") {
    try {
      const state = await readJson<{ pid: number; url: string }>(pidPath);
      const running = pidIsAlive(state.pid);
      if (sub === "stop") {
        if (running) process.kill(state.pid, "SIGTERM");
        await rm(pidPath, { force: true });
        human(
          running
            ? "대시보드를 중단했습니다."
            : "종료된 대시보드의 stale 상태 파일을 정리했습니다.",
        );
      } else print({ ...state, running }, true);
    } catch {
      human("실행 중인 대시보드가 없습니다.");
    }
    return;
  }
  const port = Number(takeOption(args, "--port") ?? 7331);
  const dashboard = await startDashboard(root, {
    port,
    all: takeFlag(args, "--all"),
  });
  await writeJson(pidPath, {
    pid: process.pid,
    url: dashboard.url,
    startedAt: now(),
  });
  if (takeFlag(args, "--open")) await openUrl(dashboard.url);
  human(`Ralph Control Center: ${dashboard.url}`);
  const close = async () => {
    dashboard.server.close();
    await rm(pidPath, { force: true });
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  await new Promise<void>((resolvePromise) =>
    dashboard.server.once("close", resolvePromise),
  );
}

async function commandHistory(args: string[]): Promise<void> {
  const sub = args.shift() ?? "list";
  const root = await projectRoot(args);
  if (sub === "list") {
    print(await listRuns(root), true);
    return;
  }
  if (sub === "delete") {
    if (!args.length)
      throw new RalphError(
        "삭제할 run ID가 필요합니다.",
        "invalid_argument",
        2,
      );
    for (const id of args) await deleteRun(root, id);
    return;
  }
  if (sub === "clear") {
    if (
      !takeFlag(args, "--yes") &&
      !(await confirm("종료된 모든 로컬 실행 증거를 삭제하시겠습니까?"))
    )
      return;
    for (const run of (await listRuns(root)).filter(
      (item) => item.status !== "running",
    ))
      await deleteRun(root, run.id);
    return;
  }
  throw new RalphError(
    "history는 list, delete, clear를 지원합니다.",
    "invalid_argument",
    2,
  );
}

async function commandConfig(args: string[]): Promise<void> {
  const sub = args.shift() ?? "show";
  const root = await projectRoot(args);
  let config = await loadConfig(root);
  if (sub === "show") {
    print(config, true);
    return;
  }
  if (sub === "refresh") {
    config = await refreshProjectConfig(config, config.preset);
    await saveConfig(root, config);
    print(config, true);
    return;
  }
  if (sub === "route") {
    await commandConfigRoute(root, config, args);
    return;
  }
  if (sub === "coverage") {
    const action = args.shift() ?? "show";
    if (action === "show") {
      print(config.verification?.coverageBaseline ?? null, true);
      return;
    }
    if (action === "capture") {
      const measured = await readCoverageSummary(root);
      if (!measured)
        throw new RalphError(
          "coverage/coverage-summary.json을 찾지 못했습니다. coverage reporter를 먼저 실행해 주세요.",
          "coverage_not_found",
          2,
        );
      config.verification = {
        ...(config.verification ?? { frozenInvariants: [] }),
        coverageBaseline: measured,
      };
      await saveConfig(root, config);
      print(measured, true);
      return;
    }
    if (action === "reset") {
      if (config.verification) delete config.verification.coverageBaseline;
      await saveConfig(root, config);
      return;
    }
    throw new RalphError(
      "config coverage는 show, capture, reset을 지원합니다.",
      "invalid_argument",
      2,
    );
  }
  if (sub === "invariant") {
    const action = args.shift() ?? "list";
    config.verification ??= { frozenInvariants: [] };
    if (action === "list") {
      print(config.verification.frozenInvariants, true);
      return;
    }
    const pattern = args[0];
    if (!pattern)
      throw new RalphError(
        "invariant 경로 또는 패턴이 필요합니다.",
        "invalid_argument",
        2,
      );
    if (action === "add")
      config.verification.frozenInvariants = [
        ...new Set([...config.verification.frozenInvariants, pattern]),
      ];
    else if (action === "remove")
      config.verification.frozenInvariants =
        config.verification.frozenInvariants.filter((item) => item !== pattern);
    else
      throw new RalphError(
        "config invariant는 list, add, remove를 지원합니다.",
        "invalid_argument",
        2,
      );
    await saveConfig(root, config);
    print(config.verification.frozenInvariants, true);
    return;
  }
  if (sub === "pipelines") {
    print(config.routes, true);
    return;
  }
  if (sub === "explain") {
    const profile = takeOption(args, "--profile") as
      ExecutionProfile | undefined;
    if (profile && !["balanced", "quality", "fast", "budget"].includes(profile))
      throw new RalphError(
        "profile은 balanced, quality, fast, budget 중 하나입니다.",
        "invalid_argument",
        2,
      );
    if (profile) config = await refreshProjectConfig(config, profile);
    print(explainRoutes(config), true);
    return;
  }
  if (sub === "preset") {
    const preset = args[0] as ExecutionProfile;
    if (!["balanced", "quality", "fast", "budget"].includes(preset))
      throw new RalphError("preset 값이 필요합니다.", "invalid_argument", 2);
    config = await setPreset(config, preset);
    await saveConfig(root, config);
    print(explainRoutes(config), true);
    return;
  }
  if (sub === "export") {
    print(config, true);
    return;
  }
  if (sub === "import") {
    const path = args[0];
    if (!path || !isAbsolute(path))
      throw new RalphError(
        "import할 절대 JSON 경로가 필요합니다.",
        "invalid_argument",
        2,
      );
    const imported = await readJson<ProjectConfig>(path);
    if (imported.schemaVersion !== 1 || imported.projectRoot !== root)
      throw new RalphError(
        "설정 schema 또는 projectRoot가 맞지 않습니다.",
        "invalid_config",
        2,
      );
    await saveConfig(root, imported);
    return;
  }
  throw new RalphError(
    "지원하지 않는 config 하위 명령입니다.",
    "invalid_argument",
    2,
  );
}

const ROUTE_KEYS = [
  "planning_architecture",
  "frontend_visual",
  "backend_core",
  "tdd_debugging",
  "static_review",
  "delivery_evidence",
  "contractPlanner",
  "router",
  "critic",
  "metaPrompter",
  "worker",
  "adjudicator",
] as const;
type RouteKey = TaskType | AgentRole;

function assertRouteKey(value: string | undefined): RouteKey {
  if (!value || !(ROUTE_KEYS as readonly string[]).includes(value))
    throw new RalphError(
      `route 대상은 다음 중 하나여야 합니다: ${ROUTE_KEYS.join(", ")}`,
      "invalid_argument",
      2,
    );
  return value as RouteKey;
}

async function resolveCandidate(
  config: ProjectConfig,
  key: RouteKey,
  value: string,
): Promise<RouteEntry> {
  const [connectionAndModel, effort] = value.split("@");
  const separator = connectionAndModel?.lastIndexOf("=") ?? -1;
  if (separator <= 0)
    throw new RalphError(
      "--candidate는 connection-id=model-id@effort 형식이어야 합니다.",
      "invalid_argument",
      2,
    );
  const connectionId = connectionAndModel!.slice(0, separator);
  const modelId = connectionAndModel!.slice(separator + 1);
  let route = Object.values(config.routes)
    .flat()
    .find(
      (item) => item.connectionId === connectionId && item.modelId === modelId,
    );
  if (!route) {
    const connection = config.connections.find(
      (item) => item.id === connectionId && item.enabled,
    );
    if (connection) {
      route = buildRoutes(
        await loadCatalog(),
        [{ ...connection, models: [modelId] }],
        config.preset,
      )[key][0];
      if (!route && connection.models?.includes(modelId))
        route = {
          connectionId,
          provider: connection.provider,
          modelId,
          displayName: modelId,
          reasoningEffort: effort ?? "",
          score: 0,
          qualityScore: 0,
          source: "override",
          degradedCapabilities: ["unrated_model"],
        };
    }
  }
  if (!route)
    throw new RalphError(
      `${connectionId}/${modelId}은 현재 카탈로그와 연결에서 사용할 수 없습니다.`,
      "model_unavailable",
      5,
    );
  return effort
    ? { ...route, reasoningEffort: effort, source: "override" }
    : { ...route, source: "override" };
}

async function commandConfigRoute(
  root: string,
  config: ProjectConfig,
  args: string[],
): Promise<void> {
  const action = args.shift() ?? "list";
  config.routePolicies ??= {};
  if (action === "list") {
    print(config.routePolicies, true);
    return;
  }
  const key = assertRouteKey(args.shift());
  if (action === "set") {
    const mode = (takeOption(args, "--mode") ?? "adaptive") as
      "adaptive" | "fixed";
    if (!["adaptive", "fixed"].includes(mode))
      throw new RalphError(
        "route mode는 adaptive 또는 fixed입니다.",
        "invalid_argument",
        2,
      );
    const candidates = await Promise.all(
      takeOptions(args, "--candidate").map((value) =>
        resolveCandidate(config, key, value),
      ),
    );
    if (!candidates.length)
      throw new RalphError(
        "최소 하나의 --candidate가 필요합니다.",
        "invalid_argument",
        2,
      );
    config.routePolicies[key] = {
      ...(config.routePolicies[key] ?? {}),
      mode,
      candidates,
    };
  } else if (action === "pin") {
    const connectionId = takeOption(args, "--connection");
    const modelId = takeOption(args, "--model");
    const reasoningEffort = takeOption(args, "--effort");
    if (!connectionId || !modelId)
      throw new RalphError(
        "pin에는 --connection과 --model이 필요합니다.",
        "invalid_argument",
        2,
      );
    const pinned = await resolveCandidate(
      config,
      key,
      `${connectionId}=${modelId}${reasoningEffort ? `@${reasoningEffort}` : ""}`,
    );
    const existing =
      config.routePolicies[key]?.candidates ?? config.routes[key];
    const candidates = existing.some(
      (route) =>
        route.connectionId === connectionId && route.modelId === modelId,
    )
      ? existing
      : [pinned, ...existing];
    config.routePolicies[key] = {
      ...(config.routePolicies[key] ?? { mode: "adaptive" }),
      candidates,
      hardPin: {
        connectionId,
        modelId,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      },
    };
  } else if (action === "unpin") {
    const policy = config.routePolicies[key];
    if (policy) {
      const { hardPin: _pin, ...rest } = policy;
      config.routePolicies[key] = rest;
    }
  } else if (action === "reset") {
    delete config.routePolicies[key];
  } else if (action === "explain") {
    const policy = config.routePolicies[key] ?? { mode: "adaptive" };
    print({ key, policy, generatedChain: config.routes[key] }, true);
    return;
  } else
    throw new RalphError(
      "config route는 list, set, pin, unpin, reset, explain을 지원합니다.",
      "invalid_argument",
      2,
    );
  await saveConfig(root, config);
  print({ key, policy: config.routePolicies[key] }, true);
}

async function spawnInteractive(
  command: string,
  commandArgs: string[],
): Promise<number> {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, commandArgs, { stdio: "inherit" });
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
}

async function commandAuth(args: string[]): Promise<void> {
  const sub = args.shift() ?? "status";
  const root = await projectRoot(args);
  let config = await loadConfig(root);
  if (sub === "status") {
    const rows = [];
    for (const connection of config.connections)
      rows.push({
        connection: connection.id,
        enabled: connection.enabled,
        ...(await createAdapter(connection, config).authStatus()),
      });
    print(rows, true);
    return;
  }
  if (sub === "login") {
    const id = args[0];
    const connection = config.connections.find((item) => item.id === id);
    if (!connection)
      throw new RalphError(
        "로그인할 connection ID가 필요합니다.",
        "invalid_argument",
        2,
      );
    const mapping: Record<string, [string, string[]] | undefined> = {
      "codex-builtin": ["codex", ["login"]],
      "claude-code-builtin": ["claude", ["auth", "login"]],
      "gemini-cli-builtin": ["gemini", []],
    };
    const command = mapping[connection.adapter];
    if (!command)
      throw new RalphError(
        `${connection.adapter}는 자동 로그인 명령을 제공하지 않습니다. 해당 Provider의 공식 CLI/IDE에서 로그인해 주세요.`,
        "login_manual",
        2,
      );
    process.exitCode = await spawnInteractive(command[0], command[1]);
    return;
  }
  if (sub === "add") {
    const id = args[0];
    if (!id || !takeFlag(args, "--key-stdin"))
      throw new RalphError(
        "ralph auth add <connection-id> --key-stdin 형식으로 키를 stdin에 전달해 주세요.",
        "invalid_argument",
        2,
      );
    let connection = config.connections.find((item) => item.id === id);
    if (!connection) {
      connection = (await detectConnections()).find((item) => item.id === id);
      if (connection) config.connections.push(connection);
    }
    if (!connection || connection.mode !== "api")
      throw new RalphError(
        "등록 가능한 API connection ID가 아닙니다.",
        "invalid_argument",
        2,
      );
    const mode = await setCredential(id, (await stdinText()).trim());
    if (mode === "unavailable")
      throw new RalphError(
        "OS 자격 증명 저장소를 사용할 수 없습니다. 해당 connection의 환경변수를 사용해 주세요.",
        "credential_store_unavailable",
        2,
      );
    connection.enabled = true;
    config = await setPreset(config, config.preset);
    await saveConfig(root, config);
    human(
      `${id} 키를 OS 자격 증명 저장소에 보관하고 경로를 다시 계산했습니다.`,
    );
    return;
  }
  if (sub === "remove") {
    const id = args[0];
    if (!id)
      throw new RalphError(
        "connection ID가 필요합니다.",
        "invalid_argument",
        2,
      );
    await removeCredential(id);
    const connection = config.connections.find((item) => item.id === id);
    if (connection?.mode === "api") {
      const remaining = await getCredential(id, connection.apiKeyEnv);
      connection.enabled = Boolean(remaining);
      config = await setPreset(config, config.preset);
      await saveConfig(root, config);
      if (remaining)
        human(
          `${connection.apiKeyEnv} 환경변수가 남아 있어 ${id} 연결은 계속 활성 상태입니다.`,
        );
    }
    return;
  }
  throw new RalphError(
    "auth는 status, login, add, remove를 지원합니다.",
    "invalid_argument",
    2,
  );
}

async function commandProviders(args: string[]): Promise<void> {
  const sub = args.shift() ?? "list";
  const root = await projectRoot(args);
  if (sub === "detect") {
    print(await detectConnections(), true);
    return;
  }
  if (sub === "list") {
    const config = await loadConfig(root);
    print(
      await Promise.all(
        config.connections.map(async (connection) => ({
          ...connection,
          capability: await probeProvider(
            connection,
            createAdapter(connection, config),
          ),
        })),
      ),
      true,
    );
    return;
  }
  throw new RalphError(
    "providers는 list, detect를 지원합니다.",
    "invalid_argument",
    2,
  );
}

async function commandIntegrations(args: string[]): Promise<void> {
  const sub = args.shift() ?? "status";
  if (sub === "status") {
    print(await integrationStatus(), true);
    return;
  }
  if (sub === "install") {
    for (const item of await installIntegrations(args)) human(`설치: ${item}`);
    return;
  }
  if (sub === "uninstall") {
    for (const item of await uninstallIntegrations(args))
      human(`제거: ${item}`);
    return;
  }
  throw new RalphError(
    "integrations는 install, uninstall, status를 지원합니다.",
    "invalid_argument",
    2,
  );
}
async function commandCatalog(args: string[]): Promise<void> {
  const sub = args.shift() ?? "status";
  if (sub === "status") {
    print(await catalogStatus({ checkRemote: true }), true);
    return;
  }
  if (sub === "diff") {
    print(await catalogDiff(), true);
    return;
  }
  if (sub === "update") {
    print(await updateCatalog(), true);
    return;
  }
  throw new RalphError(
    "catalog는 status, diff, update를 지원합니다.",
    "invalid_argument",
    2,
  );
}
async function commandBenchmark(args: string[]): Promise<void> {
  const sub = args.shift() ?? "report";
  const root = await projectRoot(args);
  if (sub === "run") {
    const suitePath = resolveSuitePath(takeOption(args, "--suite"));
    const caseId = takeOption(args, "--case");
    const repetitions = Number(takeOption(args, "--repetitions") ?? 5);
    if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20)
      throw new RalphError(
        "--repetitions는 1~20 정수여야 합니다.",
        "invalid_argument",
        2,
      );
    print(
      await runBenchmark(root, {
        ...(suitePath ? { suitePath } : {}),
        ...(caseId ? { caseId } : {}),
        repetitions,
      }),
      true,
    );
    return;
  }
  if (sub === "compare") {
    const baseline = args[0];
    const candidate = args[1];
    if (!baseline || !candidate)
      throw new RalphError(
        "benchmark compare <baseline> <candidate> 형식입니다.",
        "invalid_argument",
        2,
      );
    print(
      compareBenchmarkResults(
        await loadBenchmarkResult(root, baseline),
        await loadBenchmarkResult(root, candidate),
      ),
      true,
    );
    return;
  }
  if (sub === "report") {
    const id = args[0];
    if (!id)
      throw new RalphError(
        "benchmark report에는 run ID가 필요합니다.",
        "invalid_argument",
        2,
      );
    print(await loadBenchmarkResult(root, id), true);
    return;
  }
  if (sub === "baseline" && args.shift() === "set") {
    const id = args[0];
    if (!id)
      throw new RalphError(
        "benchmark baseline set에는 run ID가 필요합니다.",
        "invalid_argument",
        2,
      );
    await setBenchmarkBaseline(root, id);
    human(`${id}을 benchmark 기준선으로 지정했습니다.`);
    return;
  }
  if (sub === "calibrate") {
    const id = args.shift();
    const caseId = takeOption(args, "--case");
    const repetition = Number(takeOption(args, "--repetition") ?? 1);
    const outcome = takeOption(args, "--outcome") as
      "pass" | "fail" | "uncertain" | undefined;
    const note = takeOption(args, "--note") ?? "";
    if (
      !id ||
      !caseId ||
      !outcome ||
      !["pass", "fail", "uncertain"].includes(outcome)
    )
      throw new RalphError(
        "benchmark calibrate <run-id> --case <id> --repetition <n> --outcome pass|fail|uncertain --note <text> 형식입니다.",
        "invalid_argument",
        2,
      );
    print(
      await recordHumanCalibration(root, id, {
        caseId,
        repetition,
        outcome,
        note,
      }),
      true,
    );
    return;
  }
  throw new RalphError(
    "benchmark는 run, compare, report, baseline set, calibrate를 지원합니다.",
    "invalid_argument",
    2,
  );
}
async function commandMigrate(args: string[]): Promise<void> {
  const root = await projectRoot(args);
  const cleanup = takeFlag(args, "--cleanup");
  const manifest = await migrateLegacy(root);
  print(manifest, true);
  if (cleanup) {
    if (
      !takeFlag(args, "--yes") &&
      !(await confirm(
        "기존 .ralph와 .antigravity 제어 파일을 제거하시겠습니까?",
      ))
    )
      return;
    await cleanupLegacy(root);
    human("legacy 제어 파일을 제거했습니다. Git으로 복구할 수 있습니다.");
  }
}
async function commandShow(args: string[]): Promise<void> {
  const sub = args.shift();
  const root = await projectRoot(args);
  const paths = await statePaths(root);
  if (sub === "contract") {
    const run = (await listRuns(root))[0];
    if (!run) throw new RalphError("계약이 없습니다.", "not_found", 2);
    print(await loadContract(root, run.contractId), true);
    return;
  }
  if (sub === "progress") {
    try {
      print(await readFile(paths.progress, "utf8"));
    } catch {
      print("");
    }
    return;
  }
  if (sub === "guardrails") {
    print(await readFile(paths.guardrails, "utf8"));
    return;
  }
  throw new RalphError(
    "show는 contract, progress, guardrails를 지원합니다.",
    "invalid_argument",
    2,
  );
}
function help(): void {
  print(
    `Ralph ${VERSION}\n\n사용법: ralph <command> [options]\n\ninit, doctor, plan, run, graph, explain, respond, draft, status, stop, resume, recover\nusage, capacity, dashboard, history, config, auth, providers\nintegrations, catalog, benchmark, migrate, show, logs\n\nGit 저장소 밖에서는 --project /absolute/path/to/project를 사용합니다.`,
  );
}

async function main(): Promise<void> {
  const command = argv.shift();
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    help();
    return;
  }
  if (command === "--version" || command === "-V") {
    print(VERSION);
    return;
  }
  if (await graphCli(command, argv)) return;
  const commands: Record<string, (args: string[]) => Promise<void>> = {
    init: commandInit,
    doctor: commandDoctor,
    draft: commandDraft,
    recover: commandRecover,
    capacity: commandCapacity,
    dashboard: commandDashboard,
    history: commandHistory,
    config: commandConfig,
    auth: commandAuth,
    providers: commandProviders,
    integrations: commandIntegrations,
    catalog: commandCatalog,
    benchmark: commandBenchmark,
    migrate: commandMigrate,
    show: commandShow,
  };
  const handler = commands[command];
  if (!handler)
    throw new RalphError(
      `알 수 없는 명령입니다: ${command}`,
      "invalid_argument",
      2,
    );
  await handler(argv);
}

main().catch((error) => {
  if (error?.question)
    process.stdout.write(
      `${JSON.stringify({ runId: error.runId, status: "awaiting_input", question: error.question })}\n`,
    );
  process.stderr.write(`ERROR: ${formatError(error)}\n`);
  process.exitCode = error?.question
    ? 10
    : error instanceof RalphError
      ? error.exitCode
      : 1;
});

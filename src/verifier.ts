import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProjectConfig, RiskTier, TaskContract } from "./types.js";
import { runCommand } from "./util.js";

export interface VerificationGate {
  id: string;
  status: "pass" | "fail" | "not_applicable";
  evidence: string[];
}

export interface VerifierResult {
  ok: boolean;
  exitCode: number;
  summary: string;
  commands: Array<{
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  gates: VerificationGate[];
  riskTier: RiskTier;
}

function shellCommand(command: string): { command: string; args: string[] } {
  return process.platform === "win32"
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", command] }
    : { command: "/bin/sh", args: ["-lc", command] };
}

async function executeCommands(
  projectRoot: string,
  commands: string[],
  stopOnFailure = true,
  signal?: AbortSignal,
): Promise<VerifierResult["commands"]> {
  const rows: VerifierResult["commands"] = [];
  for (const command of commands) {
    const shell = shellCommand(command);
    const result = await runCommand(shell.command, shell.args, {
      cwd: projectRoot,
      timeoutMs: 900_000,
      signal,
    });
    rows.push({
      command,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(-32_000),
      stderr: result.stderr.slice(-32_000),
    });
    if (stopOnFailure && result.exitCode !== 0) break;
  }
  return rows;
}

function pathPatternMatches(path: string, pattern: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  const escaped = normalized
    .replace(/[.+^$\{\}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${escaped}$`).test(path.replaceAll("\\", "/"));
}

async function changedPaths(
  projectRoot: string,
  baseHead = "HEAD",
): Promise<string[]> {
  const changed = await runCommand(
    "git",
    ["diff", "--name-only", "-z", baseHead, "--"],
    { cwd: projectRoot },
  );
  const untracked = await runCommand(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: projectRoot },
  );
  return [
    ...new Set(
      (changed.stdout + "\0" + untracked.stdout).split("\0").filter(Boolean),
    ),
  ];
}

async function artifactRows(
  projectRoot: string,
  requiredArtifacts: string[],
): Promise<VerifierResult["commands"]> {
  const rows: VerifierResult["commands"] = [];
  for (const artifact of requiredArtifacts) {
    const target = resolve(projectRoot, artifact);
    const rel = relative(projectRoot, target);
    let exitCode = 0;
    let stderr = "";
    if (
      !artifact ||
      isAbsolute(artifact) ||
      rel === ".." ||
      rel.startsWith(`..${sep}`)
    ) {
      exitCode = 2;
      stderr = "필수 산출물 경로는 프로젝트 내부 상대 경로여야 합니다.";
    } else {
      try {
        if ((await lstat(target)).isSymbolicLink())
          throw new Error("심볼릭 링크는 산출물 증거로 허용하지 않습니다.");
      } catch (error) {
        exitCode = 1;
        stderr = error instanceof Error ? error.message : String(error);
      }
    }
    rows.push({
      command: `artifact ${artifact}`,
      exitCode,
      stdout: exitCode === 0 ? "존재 확인" : "",
      stderr,
    });
    if (exitCode !== 0) break;
  }
  return rows;
}

async function policyGates(
  projectRoot: string,
  config: ProjectConfig,
  contract?: TaskContract,
  baseHead = "HEAD",
): Promise<VerificationGate[]> {
  const paths = await changedPaths(projectRoot, baseHead);
  const gates: VerificationGate[] = [];
  const frozen = config.verification?.frozenInvariants ?? [];
  const frozenChanged = paths.filter((path) =>
    frozen.some((pattern) => pathPatternMatches(path, pattern)),
  );
  const approvedFrozen = new Set(
    (contract?.constraints ?? [])
      .filter((item) => item.startsWith("allow-frozen:"))
      .map((item) => item.slice("allow-frozen:".length)),
  );
  const blockedFrozen = frozenChanged.filter(
    (path) => !approvedFrozen.has(path),
  );
  gates.push({
    id: "frozen_invariants",
    status: blockedFrozen.length
      ? "fail"
      : frozen.length
        ? "pass"
        : "not_applicable",
    evidence: blockedFrozen.length
      ? blockedFrozen.map(
          (path) => `${path} 변경에는 allow-frozen:${path} 승인이 필요합니다.`,
        )
      : frozen.length
        ? ["승인되지 않은 frozen invariant 변경이 없습니다."]
        : ["등록된 frozen invariant가 없습니다."],
  });

  const diff = await runCommand(
    "git",
    ["diff", "--unified=0", baseHead, "--"],
    { cwd: projectRoot },
  );
  const conflictMarkers = diff.stdout
    .split(/\r?\n/)
    .filter((line) => /^\+(<<<<<<< |>>>>>>> )/.test(line));
  gates.push({
    id: "unresolved_conflicts",
    status: conflictMarkers.length ? "fail" : "pass",
    evidence: conflictMarkers.length
      ? conflictMarkers
      : ["No added Git conflict markers"],
  });
  const weakening = diff.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .filter((line) =>
      /\b(?:it|test|describe)\.(?:skip|only)\b|coverageThreshold\s*:\s*0|--passWithNoTests|eslint-disable|@ts-ignore/i.test(
        line,
      ),
    );
  const untracked = await runCommand(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: projectRoot },
  );
  for (const path of untracked.stdout.split("\0").filter(Boolean)) {
    try {
      const target = resolve(projectRoot, path);
      const stats = await lstat(target);
      if (!stats.isFile() || stats.size > 256_000) continue;
      const content = await readFile(target, "utf8");
      const matches = content
        .split(/\r?\n/)
        .filter((line) =>
          /\b(?:it|test|describe)\.(?:skip|only)\b|coverageThreshold\s*:\s*0|--passWithNoTests|eslint-disable|@ts-ignore/i.test(
            line,
          ),
        );
      weakening.push(...matches.slice(0, 20).map((line) => `${path}: ${line}`));
    } catch {
      /* Binary or concurrently removed untracked files are handled by other gates. */
    }
  }
  gates.push({
    id: "test_tampering",
    status: weakening.length ? "fail" : "pass",
    evidence: weakening.length
      ? weakening.slice(0, 20)
      : ["새로운 skip/only, 검증 우회 또는 임계값 무력화 패턴이 없습니다."],
  });

  const excluded = contract?.exclude ?? [];
  const excludedChanges = paths.filter((path) =>
    excluded.some(
      (pattern) => pathPatternMatches(path, pattern) || path === pattern,
    ),
  );
  gates.push({
    id: "contract_drift",
    status: excludedChanges.length ? "fail" : "pass",
    evidence: excludedChanges.length
      ? excludedChanges.map((path) => `exclude 범위 변경: ${path}`)
      : ["계약의 exclude 범위를 변경하지 않았습니다."],
  });
  return gates;
}

interface CoverageTotals {
  lines?: number;
  branches?: number;
  functions?: number;
}

export async function readCoverageSummary(
  projectRoot: string,
): Promise<CoverageTotals | undefined> {
  for (const candidate of [
    "coverage/coverage-summary.json",
    "coverage-summary.json",
  ]) {
    try {
      const json = JSON.parse(
        await readFile(join(projectRoot, candidate), "utf8"),
      ) as { total?: Record<string, { pct?: number }> };
      if (!json.total) continue;
      return {
        lines: json.total.lines?.pct,
        branches: json.total.branches?.pct,
        functions: json.total.functions?.pct,
      };
    } catch {
      /* Try the next standard report location. */
    }
  }
  return undefined;
}

async function coverageGate(
  projectRoot: string,
  config: ProjectConfig,
): Promise<VerificationGate> {
  const baseline = config.verification?.coverageBaseline;
  const current = await readCoverageSummary(projectRoot);
  if (!baseline && !current)
    return {
      id: "coverage_ratchet",
      status: "not_applicable",
      evidence: ["coverage summary와 기준선이 없습니다."],
    };
  if (baseline && !current)
    return {
      id: "coverage_ratchet",
      status: "fail",
      evidence: [
        "coverage 기준선이 있지만 이번 검증에서 coverage-summary.json이 생성되지 않았습니다.",
      ],
    };
  if (!baseline && current)
    return {
      id: "coverage_ratchet",
      status: "pass",
      evidence: [`초기 coverage 측정값: ${JSON.stringify(current)}`],
    };
  const regressions = (["lines", "branches", "functions"] as const)
    .filter(
      (key) =>
        baseline?.[key] !== undefined &&
        current?.[key] !== undefined &&
        current[key]! < baseline[key]!,
    )
    .map((key) => `${key}: ${baseline![key]}% → ${current![key]}%`);
  return {
    id: "coverage_ratchet",
    status: regressions.length ? "fail" : "pass",
    evidence: regressions.length
      ? regressions
      : [`기준선 유지: ${JSON.stringify(current)}`],
  };
}

async function withDisposableWorktree<T>(
  projectRoot: string,
  action: (worktree: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "ralph-verify-"));
  const added = await runCommand(
    "git",
    ["worktree", "add", "--detach", directory, "HEAD"],
    { cwd: projectRoot },
  );
  if (added.exitCode !== 0) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(added.stderr || "검증용 worktree 생성 실패");
  }
  try {
    const patch = await runCommand("git", ["diff", "--binary", "HEAD", "--"], {
      cwd: projectRoot,
    });
    if (patch.stdout) {
      const applied = await runCommand("git", ["apply", "--binary", "-"], {
        cwd: directory,
        input: patch.stdout,
      });
      if (applied.exitCode !== 0)
        throw new Error(applied.stderr || "검증용 diff 적용 실패");
    }
    const untracked = await runCommand(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: projectRoot },
    );
    for (const path of untracked.stdout.split("\0").filter(Boolean)) {
      const source = resolve(projectRoot, path);
      const target = resolve(directory, path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    try {
      const sourceModules = join(projectRoot, "node_modules");
      await lstat(sourceModules);
      await symlink(
        sourceModules,
        join(directory, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      /* Non-Node projects or worktrees with their own dependencies. */
    }
    return await action(directory);
  } finally {
    await runCommand("git", ["worktree", "remove", "--force", directory], {
      cwd: projectRoot,
    });
    await rm(directory, { recursive: true, force: true });
  }
}

async function cleanVerificationGate(
  projectRoot: string,
  commands: string[],
): Promise<VerificationGate> {
  try {
    const rows = await withDisposableWorktree(projectRoot, (worktree) =>
      executeCommands(worktree, commands),
    );
    const failed = rows.find((row) => row.exitCode !== 0);
    return {
      id: "clean_worktree_verification",
      status: failed ? "fail" : "pass",
      evidence: failed
        ? [
            `${failed.command}: exit ${failed.exitCode}`,
            failed.stderr.slice(-2_000),
          ]
        : [`격리된 worktree에서 ${rows.length}개 명령을 통과했습니다.`],
    };
  } catch (error) {
    return {
      id: "clean_worktree_verification",
      status: "fail",
      evidence: [error instanceof Error ? error.message : String(error)],
    };
  }
}

async function mutationBiteGate(
  projectRoot: string,
  commands: string[],
  baseHead = "HEAD",
): Promise<VerificationGate> {
  const test = commands.find((command) =>
    /(^|\s)(test|vitest|jest|pytest|cargo test|go test)(\s|$)|npm run test|npm test/i.test(
      command,
    ),
  );
  const changed = await changedPaths(projectRoot, baseHead);
  const sources = changed.filter(
    (path) =>
      /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift)$/i.test(path) &&
      !/(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|\.|$)|\.(?:test|spec)\./i.test(
        path,
      ),
  );
  const tests = changed.filter((path) =>
    /(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|\.|$)|\.(?:test|spec)\./i.test(
      path,
    ),
  );
  if (!test || !sources.length || !tests.length)
    return {
      id: "mutation_bite",
      status: "not_applicable",
      evidence: [
        "동시에 변경된 구현·테스트 파일과 테스트 명령이 모두 있어야 실행합니다.",
      ],
    };
  try {
    const source = sources[0]!;
    const result = await withDisposableWorktree(
      projectRoot,
      async (worktree) => {
        const tracked = await runCommand(
          "git",
          ["cat-file", "-e", `${baseHead}:${source}`],
          { cwd: projectRoot },
        );
        if (tracked.exitCode === 0)
          await runCommand(
            "git",
            ["restore", "--source", baseHead, "--", source],
            { cwd: worktree },
          );
        else await rm(resolve(worktree, source), { force: true });
        return (await executeCommands(worktree, [test]))[0]!;
      },
    );
    return result.exitCode !== 0
      ? {
          id: "mutation_bite",
          status: "pass",
          evidence: [
            `${source} 변경을 제거하자 테스트가 exit ${result.exitCode}로 실패했습니다.`,
          ],
        }
      : {
          id: "mutation_bite",
          status: "fail",
          evidence: [
            `${source} 변경을 제거해도 ${test}가 통과했습니다. 새 테스트가 구현 변화를 실제로 검증하는지 확인해 주세요.`,
          ],
        };
  } catch (error) {
    return {
      id: "mutation_bite",
      status: "fail",
      evidence: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export async function runVerifier(
  projectRoot: string,
  config: ProjectConfig,
  contractCommands: string[],
  requiredArtifacts: string[] = [],
  options: {
    riskTier?: RiskTier;
    contract?: TaskContract;
    signal?: AbortSignal;
    baseHead?: string;
  } = {},
): Promise<VerifierResult> {
  const riskTier = options.riskTier ?? "T1";
  const commands = contractCommands.length
    ? contractCommands
    : config.verifierCommands;
  const rows = await artifactRows(projectRoot, requiredArtifacts);
  if (!rows.some((row) => row.exitCode !== 0))
    rows.push(
      ...(await executeCommands(projectRoot, commands, true, options.signal)),
    );
  const gates = await policyGates(
    projectRoot,
    config,
    options.contract,
    options.baseHead,
  );
  gates.push(await coverageGate(projectRoot, config));
  if (riskTier === "T2" || riskTier === "T3") {
    gates.push(await cleanVerificationGate(projectRoot, commands));
    gates.push(await mutationBiteGate(projectRoot, commands, options.baseHead));
  } else {
    gates.push({
      id: "clean_worktree_verification",
      status: "not_applicable",
      evidence: [`${riskTier} 작업에는 격리 재검증을 강제하지 않습니다.`],
    });
    gates.push({
      id: "mutation_bite",
      status: "not_applicable",
      evidence: [`${riskTier} 작업에는 mutation bite를 강제하지 않습니다.`],
    });
  }
  const failedCommand = rows.find((row) => row.exitCode !== 0);
  const failedGate = gates.find((gate) => gate.status === "fail");
  const ok = rows.length > 0 && !failedCommand && !failedGate;
  const commandSummary = rows
    .map(
      (row) =>
        `$ ${row.command}\nexit=${row.exitCode}\n${row.stdout}\n${row.stderr}`,
    )
    .join("\n\n");
  const gateSummary = gates
    .map((gate) => `[${gate.status}] ${gate.id}\n${gate.evidence.join("\n")}`)
    .join("\n\n");
  return {
    ok,
    exitCode: ok ? 0 : (failedCommand?.exitCode ?? 12),
    summary: `${commandSummary}\n\nStrong gates\n${gateSummary}`.slice(-96_000),
    commands: rows,
    gates,
    riskTier,
  };
}

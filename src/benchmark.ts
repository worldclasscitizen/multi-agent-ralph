import { RunStore } from "./storage/run-store.js";
import { planRun } from "./nodes/planner.js";
import { approvePlan } from "./interaction/approval.js";
import { startRun } from "./runtime/supervisor.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { approveContract } from "./contracts.js";
import { executeContract } from "./orchestrator.js";
import { ensureState, loadConfig, saveConfig } from "./state.js";
import type { RiskTier, TaskContract, TaskType } from "./types.js";
import { makeId, now, readJson, runCommand, writeJson } from "./util.js";

const DEFAULT_SUITE = fileURLToPath(
  new URL("../assets/benchmarks/quality-suite.json", import.meta.url),
);

export interface BenchmarkCase {
  id: string;
  taskType: TaskType;
  difficulty: "low" | "medium" | "high" | "critical";
  riskTier: RiskTier;
  request: string;
  acceptanceCriteria: string[];
  seedFiles: Record<string, string>;
  verifierCommands: string[];
  hiddenVerifierCommands: string[];
  frozenInvariants?: string[];
}

export interface BenchmarkSuite {
  schemaVersion: 1;
  name: string;
  cases: BenchmarkCase[];
}

export interface BenchmarkObservation {
  caseId: string;
  repetition: number;
  qualifiedSuccess: boolean;
  ralphStatus: string;
  hiddenVerifierPassed: boolean;
  score?: number;
  iterations: number;
  durationMs: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
}

export interface BenchmarkResult {
  schemaVersion: 1;
  id: string;
  suite: string;
  startedAt: string;
  endedAt: string;
  repetitions: number;
  observations: BenchmarkObservation[];
  humanCalibration?: Array<{
    caseId: string;
    repetition: number;
    outcome: "pass" | "fail" | "uncertain";
    note: string;
    recordedAt: string;
  }>;
  summary: ReturnType<typeof summarizeBenchmark>;
}

async function initializeFixture(
  root: string,
  testCase: BenchmarkCase,
): Promise<void> {
  await runCommand("git", ["init"], { cwd: root });
  await runCommand(
    "git",
    ["config", "user.email", "ralph-benchmark@example.invalid"],
    { cwd: root },
  );
  await runCommand("git", ["config", "user.name", "Ralph Benchmark"], {
    cwd: root,
  });
  for (const [path, content] of Object.entries(testCase.seedFiles)) {
    const target = resolve(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await runCommand("git", ["add", "."], { cwd: root });
  await runCommand("git", ["commit", "-m", "benchmark fixture"], { cwd: root });
}

async function runHiddenVerifiers(
  root: string,
  commands: string[],
): Promise<boolean> {
  for (const command of commands) {
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const args =
      process.platform === "win32"
        ? ["/d", "/s", "/c", command]
        : ["-lc", command];
    if (
      (await runCommand(shell, args, { cwd: root, timeoutMs: 900_000 }))
        .exitCode !== 0
    )
      return false;
  }
  return true;
}

async function usageTotals(
  root: string,
  runId: string,
): Promise<{ totalTokens?: number; estimatedCostUsd?: number }> {
  const paths = await ensureState(root);
  const events = await new RunStore(paths.root, runId).readAfter();
  const seen = new Set<string>();
  const usage = [];
  for (const event of events) {
    if (
      event.type !== "invocation.finished" ||
      seen.has(event.payload.attemptId)
    )
      continue;
    seen.add(event.payload.attemptId);
    usage.push(event.payload.usage);
  }
  const tokens = usage.map(
    (u) =>
      u?.totalTokens ??
      (u?.inputTokens !== undefined && u.outputTokens !== undefined
        ? u.inputTokens + u.outputTokens
        : undefined),
  );
  const costs = usage.map((u) => u?.estimatedCostUsd);
  return {
    ...(tokens.length && tokens.every((t) => t !== undefined)
      ? { totalTokens: tokens.reduce<number>((sum, t) => sum + t!, 0) }
      : {}),
    ...(costs.length && costs.every((c) => c !== undefined)
      ? { estimatedCostUsd: costs.reduce<number>((sum, c) => sum + c!, 0) }
      : {}),
  };
}

export function wilsonInterval(
  successes: number,
  total: number,
): [number, number] {
  if (!total) return [0, 0];
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) /
    denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function quantile(values: number[], probability: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * probability))
  ]!;
}

export function bootstrapMeanInterval(
  values: number[],
  samples = 2_000,
): [number, number] {
  if (!values.length) return [0, 0];
  let seed = values.reduce(
    (state, value, index) =>
      (state ^ Math.round(value * 1_000) ^ ((index + 1) * 2654435761)) >>> 0,
    2166136261,
  );
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const means: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1)
      total += values[Math.floor(random() * values.length)]!;
    means.push(total / values.length);
  }
  return [quantile(means, 0.025), quantile(means, 0.975)];
}

export function summarizeBenchmark(observations: BenchmarkObservation[]) {
  const successes = observations.filter((item) => item.qualifiedSuccess).length;
  const successInterval = wilsonInterval(successes, observations.length);
  const durations = observations.map((item) => item.durationMs);
  const tokens = observations
    .map((item) => item.totalTokens)
    .filter((value): value is number => value !== undefined);
  const costs = observations
    .map((item) => item.estimatedCostUsd)
    .filter((value): value is number => value !== undefined);
  return {
    measuredTokenRuns: tokens.length,
    qualifiedSuccessRate: observations.length
      ? successes / observations.length
      : 0,
    qualifiedSuccessWilson95: successInterval,
    durationMs: {
      p50: quantile(durations, 0.5),
      p95: quantile(durations, 0.95),
      mean: durations.length
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 0,
      meanBootstrap95: bootstrapMeanInterval(durations),
    },
    totalTokens: {
      p50: quantile(tokens, 0.5),
      p95: quantile(tokens, 0.95),
      mean: tokens.length
        ? tokens.reduce((a, b) => a + b, 0) / tokens.length
        : 0,
      meanBootstrap95: bootstrapMeanInterval(tokens),
    },
    ...(costs.length
      ? {
          estimatedCostUsd: {
            p50: quantile(costs, 0.5),
            p95: quantile(costs, 0.95),
            mean: costs.reduce((a, b) => a + b, 0) / costs.length,
            meanBootstrap95: bootstrapMeanInterval(costs),
          },
        }
      : {}),
    averageIterations: observations.length
      ? observations.reduce((sum, item) => sum + item.iterations, 0) /
        observations.length
      : 0,
  };
}

export async function loadBenchmarkSuite(
  path = DEFAULT_SUITE,
): Promise<BenchmarkSuite> {
  const suite = await readJson<BenchmarkSuite>(path);
  if (
    suite.schemaVersion !== 1 ||
    !Array.isArray(suite.cases) ||
    suite.cases.length === 0
  )
    throw new Error("Benchmark suite schema가 올바르지 않습니다.");
  return suite;
}

export async function runBenchmark(
  projectRoot: string,
  options: { suitePath?: string; caseId?: string; repetitions?: number } = {},
): Promise<BenchmarkResult> {
  const suite = await loadBenchmarkSuite(options.suitePath);
  const selected = options.caseId
    ? suite.cases.filter((item) => item.id === options.caseId)
    : suite.cases;
  if (!selected.length)
    throw new Error(`Benchmark case를 찾지 못했습니다: ${options.caseId}`);
  const repetitions = options.repetitions ?? 5;
  const sourceConfig = await loadConfig(projectRoot);
  const result: BenchmarkResult = {
    schemaVersion: 1,
    id: makeId("bench"),
    suite: suite.name,
    startedAt: now(),
    endedAt: "",
    repetitions,
    observations: [],
    summary: summarizeBenchmark([]),
  };
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const testCase of selected) {
      const fixtureRoot = await mkdtemp(
        join(tmpdir(), `ralph-bench-${testCase.id}-`),
      );
      const started = Date.now();
      try {
        await initializeFixture(fixtureRoot, testCase);
        await saveConfig(fixtureRoot, {
          ...sourceConfig,
          projectRoot: fixtureRoot,
          verification: {
            ...(sourceConfig.verification ?? { frozenInvariants: [] }),
            frozenInvariants: testCase.frozenInvariants ?? [],
          },
        });
        const contract: TaskContract = approveContract({
          id: `${result.id}-${testCase.id}-${repetition}`,
          taskType: testCase.taskType,
          goal: testCase.request,
          include: Object.keys(testCase.seedFiles),
          exclude: [".git/**"],
          requirements: testCase.acceptanceCriteria,
          acceptanceCriteria: testCase.acceptanceCriteria,
          verifierCommands: testCase.verifierCommands,
          requiredArtifacts: [],
          attachments: [],
          constraints: [],
          executionProfile: "quality",
          projectRoot: fixtureRoot,
          riskTier: testCase.riskTier,
          routeSnapshot: sourceConfig.routes,
          routePolicySnapshot: sourceConfig.routePolicies,
          approvedCatalogVersion: sourceConfig.catalogVersion,
        });
        const graphResult = await startRun(
          approvePlan(
            await planRun(fixtureRoot, contract.goal, {
              contract,
              mode: "graph",
            }),
          ),
        );
        const run = {
          id: graphResult.runId,
          status:
            graphResult.status === "completed" ? "pass" : "needs_operator",
          iteration: Math.max(
            0,
            ...Object.values(graphResult.nodes).map((n) => n.iteration),
          ),
          score: undefined as number | undefined,
          lastCheckpoint: graphResult.resultHead,
        };
        const hiddenVerifierPassed = await runHiddenVerifiers(
          fixtureRoot,
          testCase.hiddenVerifierCommands,
        );
        const usage = await usageTotals(fixtureRoot, run.id);
        result.observations.push({
          caseId: testCase.id,
          repetition,
          qualifiedSuccess: run.status === "pass" && hiddenVerifierPassed,
          ralphStatus: run.status,
          hiddenVerifierPassed,
          score: run.score,
          iterations: run.iteration,
          durationMs: Date.now() - started,
          ...usage,
        });
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    }
  }
  result.endedAt = now();
  result.summary = summarizeBenchmark(result.observations);
  const paths = await ensureState(projectRoot);
  const directory = join(paths.root, "benchmarks");
  await mkdir(directory, { recursive: true });
  await writeJson(join(directory, `${result.id}.json`), result);
  return result;
}

export async function loadBenchmarkResult(
  projectRoot: string,
  id: string,
): Promise<BenchmarkResult> {
  const paths = await ensureState(projectRoot);
  return await readJson<BenchmarkResult>(
    join(paths.root, "benchmarks", `${id}.json`),
  );
}

export function compareBenchmarkResults(
  baseline: BenchmarkResult,
  candidate: BenchmarkResult,
) {
  return {
    baseline: baseline.id,
    candidate: candidate.id,
    qualifiedSuccessRateDelta:
      candidate.summary.qualifiedSuccessRate -
      baseline.summary.qualifiedSuccessRate,
    durationMeanDeltaMs:
      candidate.summary.durationMs.mean - baseline.summary.durationMs.mean,
    tokenMeanDelta:
      candidate.summary.measuredTokenRuns && baseline.summary.measuredTokenRuns
        ? candidate.summary.totalTokens.mean - baseline.summary.totalTokens.mean
        : null,
    qualityRegressed:
      candidate.summary.qualifiedSuccessRate <
      baseline.summary.qualifiedSuccessWilson95[0],
    recommendation:
      candidate.summary.qualifiedSuccessRate <
      baseline.summary.qualifiedSuccessRate
        ? "reject_quality_regression"
        : candidate.summary.measuredTokenRuns ===
              candidate.observations.length &&
            baseline.summary.measuredTokenRuns ===
              baseline.observations.length &&
            candidate.summary.measuredTokenRuns > 0 &&
            candidate.summary.durationMs.mean <=
              baseline.summary.durationMs.mean &&
            candidate.summary.totalTokens.mean <=
              baseline.summary.totalTokens.mean
          ? "accept_pareto_improvement"
          : "human_review_tradeoff",
  };
}

export async function setBenchmarkBaseline(
  projectRoot: string,
  id: string,
): Promise<void> {
  await loadBenchmarkResult(projectRoot, id);
  const paths = await ensureState(projectRoot);
  await writeJson(join(paths.root, "benchmarks", "baseline.json"), {
    id,
    setAt: now(),
  });
}

export async function recordHumanCalibration(
  projectRoot: string,
  id: string,
  input: {
    caseId: string;
    repetition: number;
    outcome: "pass" | "fail" | "uncertain";
    note: string;
  },
): Promise<BenchmarkResult> {
  const result = await loadBenchmarkResult(projectRoot, id);
  if (
    !result.observations.some(
      (item) =>
        item.caseId === input.caseId && item.repetition === input.repetition,
    )
  )
    throw new Error("해당 benchmark observation을 찾지 못했습니다.");
  result.humanCalibration ??= [];
  result.humanCalibration = result.humanCalibration.filter(
    (item) =>
      item.caseId !== input.caseId || item.repetition !== input.repetition,
  );
  result.humanCalibration.push({ ...input, recordedAt: now() });
  const paths = await ensureState(projectRoot);
  await writeJson(join(paths.root, "benchmarks", `${id}.json`), result);
  return result;
}

export function resolveSuitePath(value?: string): string | undefined {
  if (!value) return undefined;
  if (!isAbsolute(value))
    throw new Error("--suite에는 절대 경로가 필요합니다.");
  return value;
}

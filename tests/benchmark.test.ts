import { describe, expect, it } from "vitest";
import {
  compareBenchmarkResults,
  loadBenchmarkSuite,
  summarizeBenchmark,
  wilsonInterval,
} from "../src/benchmark.js";
import type { BenchmarkResult } from "../src/benchmark.js";

describe("quality benchmark", () => {
  it("ships 24 real task cases across all six task types", async () => {
    const suite = await loadBenchmarkSuite();
    expect(suite.cases).toHaveLength(24);
    expect(new Set(suite.cases.map((item) => item.taskType)).size).toBe(6);
    expect(
      suite.cases.every((item) => item.hiddenVerifierCommands.length > 0),
    ).toBe(true);
  });

  it("reports uncertainty and rejects a qualified-success regression", () => {
    const interval = wilsonInterval(8, 10);
    expect(interval[0]).toBeLessThan(0.8);
    expect(interval[1]).toBeGreaterThan(0.8);
    const baseSummary = summarizeBenchmark([
      {
        caseId: "x",
        repetition: 1,
        qualifiedSuccess: true,
        ralphStatus: "pass",
        hiddenVerifierPassed: true,
        score: 90,
        iterations: 1,
        durationMs: 100,
        totalTokens: 100,
      },
    ]);
    const candidateSummary = summarizeBenchmark([
      {
        caseId: "x",
        repetition: 1,
        qualifiedSuccess: false,
        ralphStatus: "retry",
        hiddenVerifierPassed: false,
        score: 70,
        iterations: 2,
        durationMs: 50,
        totalTokens: 50,
      },
    ]);
    const base = { id: "base", summary: baseSummary } as BenchmarkResult;
    const candidate = {
      id: "candidate",
      summary: candidateSummary,
    } as BenchmarkResult;
    expect(compareBenchmarkResults(base, candidate).recommendation).toBe(
      "reject_quality_regression",
    );
  });
});

it("does not treat absent token measurements as a Pareto improvement", () => {
  const obs = {
    caseId: "x",
    repetition: 1,
    qualifiedSuccess: true,
    ralphStatus: "pass",
    hiddenVerifierPassed: true,
    iterations: 1,
    durationMs: 20,
  };
  const baseline = {
    id: "base",
    observations: [{ ...obs, totalTokens: 100 }],
    summary: summarizeBenchmark([{ ...obs, totalTokens: 100 }]),
  } as BenchmarkResult;
  const candidate = {
    id: "candidate",
    observations: [obs],
    summary: summarizeBenchmark([obs]),
  } as BenchmarkResult;
  expect(compareBenchmarkResults(baseline, candidate).recommendation).toBe(
    "human_review_tradeoff",
  );
  expect(
    compareBenchmarkResults(baseline, candidate).tokenMeanDelta,
  ).toBeNull();
});

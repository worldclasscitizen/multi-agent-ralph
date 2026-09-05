import type { RouteEntry, ExecutionProfile, TaskType } from "../types.js";
import { wilsonLower } from "./metrics.js";
export interface BenchmarkMeasurement {
  benchmarkFamily: string;
  sourceUrl: string;
  modelRevision: string;
  harnessVersion: string;
  measuredAt: string;
  sampleCount: number;
  metric: string;
  value: number;
  unit: string;
  taskCategory: TaskType;
}
export interface OperationalMeasurement {
  connectionId: string;
  modelId: string;
  taskCategory: TaskType;
  verifierVersion: string;
  attempts: number;
  qualifiedSuccesses: number;
  meanLatencyMs: number;
  meanCostUsd?: number;
}
/** Compare measurements only within one task and verifier protocol. */
export function rankMeasuredRoutes(
  routes: RouteEntry[],
  samples: OperationalMeasurement[],
  task: TaskType,
  profile: ExecutionProfile,
  verifierVersion: string,
): RouteEntry[] {
  const measurements = new Map(
    samples
      .filter(
        (s) =>
          s.taskCategory === task &&
          s.verifierVersion === verifierVersion &&
          s.attempts >= 20 &&
          s.qualifiedSuccesses <= s.attempts,
      )
      .map((s) => [`${s.connectionId}/${s.modelId}`, s]),
  );
  return [...routes].sort((a, b) => {
    const quality = (b.qualityScore ?? b.score) - (a.qualityScore ?? a.score);
    if (quality !== 0) return quality;
    const am = measurements.get(`${a.connectionId}/${a.modelId}`),
      bm = measurements.get(`${b.connectionId}/${b.modelId}`);
    if (!am || !bm) return routes.indexOf(a) - routes.indexOf(b);
    const success =
      wilsonLower(bm.qualifiedSuccesses, bm.attempts) -
      wilsonLower(am.qualifiedSuccesses, am.attempts);
    if (success !== 0) return success;
    if (
      profile === "budget" &&
      am.meanCostUsd !== undefined &&
      bm.meanCostUsd !== undefined
    )
      return am.meanCostUsd - bm.meanCostUsd;
    if (profile === "fast" || profile === "balanced")
      return am.meanLatencyMs - bm.meanLatencyMs;
    return (
      a.connectionId.localeCompare(b.connectionId) ||
      a.modelId.localeCompare(b.modelId)
    );
  });
}

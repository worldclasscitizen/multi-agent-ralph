import type { EventEnvelope } from "../graph/schema.js";
export function wilsonLower(successes: number, total: number): number {
  if (total === 0) return 0;
  const p = successes / total,
    z = 1.96;
  return (
    (p +
      (z * z) / (2 * total) -
      z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) /
    (1 + (z * z) / total)
  );
}
export function aggregateUsage(events: EventEnvelope[]) {
  const seen = new Set<string>();
  const rows = new Map<
    string,
    {
      connectionId: string;
      modelId: string;
      calls: number;
      taskCalls: Record<string, number>;
      failures: number;
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      knownUsageCalls: number;
      cachedTokens: number;
      knownCachedCalls: number;
      estimatedCostUsd: number;
      knownCostCalls: number;
    }
  >();
  const tasks = new Map<string, string>();
  for (const e of events)
    if (e.type === "graph.revised")
      for (const n of e.payload.graph.nodes)
        tasks.set(`${e.runId}/${n.nodeId}`, n.taskType);
  for (const event of events) {
    if (
      event.type !== "invocation.finished" ||
      seen.has(event.payload.attemptId)
    )
      continue;
    const p = event.payload;
    seen.add(p.attemptId);
    const key = `${p.connectionId}/${p.modelId}`;
    const row = rows.get(key) ?? {
      connectionId: p.connectionId,
      modelId: p.modelId,
      calls: 0,
      taskCalls: {},
      failures: 0,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      knownUsageCalls: 0,
      cachedTokens: 0,
      knownCachedCalls: 0,
      estimatedCostUsd: 0,
      knownCostCalls: 0,
    };
    row.calls++;
    const task = tasks.get(`${event.runId}/${p.nodeId}`) ?? "control";
    row.taskCalls[task] = (row.taskCalls[task] ?? 0) + 1;
    row.failures += p.error ? 1 : 0;
    row.durationMs += p.durationMs;
    if (p.usage) {
      if (p.usage.cachedTokens !== undefined) {
        row.cachedTokens += p.usage.cachedTokens;
        row.knownCachedCalls++;
      }
      row.inputTokens += p.usage.inputTokens ?? 0;
      row.outputTokens += p.usage.outputTokens ?? 0;
      if (
        p.usage.inputTokens !== undefined &&
        p.usage.outputTokens !== undefined
      )
        row.knownUsageCalls++;
      if (p.usage.estimatedCostUsd !== undefined) {
        row.knownCostCalls++;
        row.estimatedCostUsd += p.usage.estimatedCostUsd;
      }
    }
    rows.set(key, row);
  }
  return [...rows.values()].map((r) => ({
    ...r,
    usageStatus:
      r.knownUsageCalls === r.calls
        ? "reported"
        : r.knownUsageCalls
          ? "partial"
          : "unknown",
    costStatus:
      r.knownCostCalls === r.calls
        ? "estimated"
        : r.knownCostCalls
          ? "partial_estimate"
          : "unknown",
  }));
}

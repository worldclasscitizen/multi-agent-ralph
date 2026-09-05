import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { RunStore } from "../storage/run-store.js";
import { statePaths } from "../state.js";
import { digest } from "../graph/schema.js";
import type { ProjectConfig } from "../types.js";
import type { OperationalMeasurement } from "./measurements.js";
export function verifierVersion(config: ProjectConfig): string {
  return digest({
    commands: config.verifierCommands,
    verification: config.verification,
    rubric: "ralph-0.3-v1",
  });
}
/** Snapshot only terminal logical tasks, once per run and node. Never train during execution. */
export async function collectRoutingHistory(
  projectRoot: string,
): Promise<OperationalMeasurement[]> {
  const paths = await statePaths(projectRoot),
    groups = new Map<string, OperationalMeasurement>();
  for (const id of await readdir(paths.runs).catch(() => [])) {
    let plan;
    try {
      plan = JSON.parse(
        await readFile(join(paths.runs, id, "plan.json"), "utf8"),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    const store = new RunStore(paths.root, id),
      state = await store.state();
    if (!["completed", "failed", "awaiting_input"].includes(state.status))
      continue;
    if (!Object.keys(state.nodes).length) continue;
    const graph = await store.graph(),
      events = await store.readAfter();
    for (const node of graph.nodes.filter((n) => n.kind === "worker")) {
      const result = state.nodes[node.nodeId];
      if (
        !result ||
        !["completed", "failed", "blocked"].includes(result.status)
      )
        continue;
      const calls = events.filter(
        (e) =>
          e.type === "invocation.started" &&
          e.payload.nodeId === node.nodeId &&
          e.payload.role === "worker",
      );
      const last = calls.at(-1);
      if (!last || last.type !== "invocation.started") continue;
      const p = last.payload,
        version = verifierVersion(plan.config),
        key = `${p.connectionId}/${p.modelId}/${node.taskType}/${version}`;
      const group = groups.get(key) ?? {
        connectionId: p.connectionId,
        modelId: p.modelId,
        taskCategory: node.taskType,
        verifierVersion: version,
        attempts: 0,
        qualifiedSuccesses: 0,
        meanLatencyMs: 0,
      };
      const finish = events.find(
        (e) =>
          e.type === "invocation.finished" &&
          e.payload.attemptId === p.attemptId,
      );
      if (!finish || finish.type !== "invocation.finished") continue;
      group.meanLatencyMs =
        (group.meanLatencyMs * group.attempts + finish.payload.durationMs) /
        (group.attempts + 1);
      group.attempts++;
      group.qualifiedSuccesses += result.status === "completed" ? 1 : 0;
      groups.set(key, group);
    }
  }
  return [...groups.values()];
}

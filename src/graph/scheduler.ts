import { descendants } from "./compiler.js";
import type {
  GraphRevision,
  GraphRunState,
  NodeSpec,
  NodeResult,
} from "./schema.js";
import type { RunStore } from "../storage/run-store.js";

export function readyNodes(
  graph: GraphRevision,
  state: GraphRunState,
): NodeSpec[] {
  return graph.nodes
    .filter(
      (n) =>
        ["pending", "queued"].includes(state.nodes[n.nodeId]?.status ?? "") &&
        graph.edges
          .filter((e) => e.to === n.nodeId)
          .every((e) => state.nodes[e.from]?.status === "completed"),
    )
    .sort(
      (a, b) =>
        descendants(graph, b.nodeId).size - descendants(graph, a.nodeId).size,
    );
}
export async function schedule(
  graph: GraphRevision,
  store: RunStore,
  concurrency: number,
  execute: (node: NodeSpec, signal: AbortSignal) => Promise<NodeResult>,
  signal: AbortSignal,
): Promise<GraphRunState> {
  const running = new Map<string, Promise<void>>();
  const launch = (node: NodeSpec) => {
    const task = (async () => {
      await store.append(
        {
          type: "node.status",
          payload: {
            nodeId: node.nodeId,
            generation: node.generation,
            status: "running",
          },
        },
        graph.revision,
      );
      try {
        const result = await execute(node, signal);
        await store.append(
          {
            type: "node.status",
            payload: {
              nodeId: node.nodeId,
              generation: node.generation,
              status: result.outcome,
              result,
            },
          },
          graph.revision,
        );
      } catch (e) {
        await store.append(
          {
            type: "node.status",
            payload: {
              nodeId: node.nodeId,
              generation: node.generation,
              status: signal.aborted ? "interrupted" : "blocked",
              error: e instanceof Error ? e.message : String(e),
            },
          },
          graph.revision,
        );
      }
    })();
    running.set(node.nodeId, task);
    void task.finally(() => running.delete(node.nodeId)).catch(() => {});
  };
  try {
    while (true) {
      const state = await store.state();
      if (!signal.aborted) {
        for (const node of readyNodes(graph, state)) {
          if (running.size >= concurrency) break;
          if (!running.has(node.nodeId)) launch(node);
        }
      }
      if (!running.size) break;
      await Promise.race(running.values());
    }
  } finally {
    await Promise.all(running.values());
  }
  const state = await store.state();
  if (!signal.aborted)
    for (const node of graph.nodes)
      if (
        ["pending", "queued"].includes(state.nodes[node.nodeId]?.status ?? "")
      )
        await store.append(
          {
            type: "node.status",
            payload: {
              nodeId: node.nodeId,
              generation: node.generation,
              status: "blocked",
              error: "A required dependency did not complete",
            },
          },
          graph.revision,
        );
  return store.state();
}

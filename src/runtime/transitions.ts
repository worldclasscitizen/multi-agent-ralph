import type { GraphRunState, NodeStatus, RunEvent } from "../graph/schema.js";
import { RalphError } from "../util.js";

const transitions: Record<NodeStatus, NodeStatus[]> = {
  pending: ["queued", "running", "blocked", "cancelled"],
  queued: ["running", "blocked", "cancelled"],
  running: [
    "running",
    "verifying",
    "retry_wait",
    "completed",
    "failed",
    "blocked",
    "cancelled",
    "interrupted",
  ],
  verifying: [
    "running",
    "completed",
    "failed",
    "blocked",
    "cancelled",
    "interrupted",
  ],
  retry_wait: ["running", "blocked", "cancelled", "interrupted"],
  blocked: ["pending"],
  failed: ["pending"],
  interrupted: ["pending"],
  cancelled: [],
  completed: [],
};
export function assertTransition(state: GraphRunState, event: RunEvent): void {
  if (event.type === "node.status") {
    const p = event.payload,
      old = state.nodes[p.nodeId];
    if (
      !old ||
      old.generation !== p.generation ||
      !transitions[old.status].includes(p.status)
    )
      throw new RalphError(
        `Invalid node transition: ${p.nodeId} ${old?.status} -> ${p.status}`,
        "invalid_transition",
        4,
      );
    if (p.iteration !== undefined && p.iteration < old.iteration)
      throw new RalphError(
        "Logical iteration counter cannot decrease",
        "invalid_transition",
        4,
      );
    if (
      p.result &&
      (p.result.nodeId !== p.nodeId ||
        p.result.generation !== p.generation ||
        p.result.outcome !== p.status)
    )
      throw new RalphError(
        "Node result identity or outcome mismatch",
        "invalid_transition",
        4,
      );
    if (p.status === "completed" && !p.result)
      throw new RalphError(
        "Completion requires a durable result",
        "invalid_transition",
        4,
      );
  }
  if (
    event.type === "graph.revised" &&
    state.seq > 0 &&
    Object.keys(state.nodes).length &&
    event.payload.graph.revision !== state.revision + 1
  )
    throw new RalphError(
      "Graph revision must advance exactly once",
      "revision_conflict",
      4,
    );
  if (
    event.type === "run.status" &&
    event.payload.status === "completed" &&
    (!Object.keys(state.nodes).length ||
      Object.values(state.nodes).some((n) => n.status !== "completed"))
  )
    throw new RalphError(
      "Run completion requires every node result",
      "invalid_transition",
      4,
    );
  if (
    event.type === "run.status" &&
    ["completed", "cancelled"].includes(state.status) &&
    event.payload.status !== state.status
  )
    throw new RalphError(
      "Terminal runs cannot be reopened",
      "invalid_transition",
      4,
    );
}

import { compileGraph, descendants, type GraphEnvelope } from "./compiler.js";
import { digest, type GraphRevision, type NodeState } from "./schema.js";
import { RalphError } from "../util.js";
export function reviseGraph(
  previous: GraphRevision,
  proposal: GraphRevision,
  states: Record<string, NodeState>,
  envelope: GraphEnvelope,
): GraphRevision {
  if (previous.revision >= envelope.budget.maxRevisions)
    throw new RalphError("Revision budget exhausted", "budget_exhausted", 10);
  const next = compileGraph(
    {
      ...proposal,
      runId: previous.runId,
      parentRevision: previous.revision,
      revision: previous.revision + 1,
    },
    envelope,
  );
  const changed = new Set<string>();
  for (const n of next.nodes) {
    const old = previous.nodes.find((x) => x.nodeId === n.nodeId);
    const incoming = (g: GraphRevision) =>
      g.edges.filter((e) => e.to === n.nodeId);
    if (
      !old ||
      digest({ ...old, generation: 0 }) !== digest({ ...n, generation: 0 }) ||
      digest(incoming(previous)) !== digest(incoming(next))
    )
      changed.add(n.nodeId);
  }
  for (const id of [...changed])
    for (const child of descendants(next, id)) changed.add(child);
  for (const n of next.nodes) {
    const old = previous.nodes.find((x) => x.nodeId === n.nodeId);
    if (
      changed.has(n.nodeId) &&
      ["running", "verifying"].includes(states[n.nodeId]?.status ?? "")
    )
      throw new RalphError("Cannot revise active node", "revision_conflict", 4);
    n.generation = old ? old.generation + (changed.has(n.nodeId) ? 1 : 0) : 0;
  }
  return next;
}

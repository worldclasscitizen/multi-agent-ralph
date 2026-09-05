/** Apply ordered SSE records without fetching a full snapshot for each update. */
export function projectEvent(
  state: Record<string, any>,
  event: Record<string, any>,
): Record<string, any> {
  if (event.seq <= state.seq) return state;
  if (event.seq !== state.seq + 1)
    throw new Error("Event sequence gap requires a snapshot");
  const next: Record<string, any> = {
    ...state,
    seq: event.seq,
    updatedAt: event.timestamp,
    nodes: { ...state.nodes },
  };
  const p = event.payload;
  switch (event.type) {
    case "run.status":
      Object.assign(next, p);
      break;
    case "graph.revised":
      next.revision = p.graph.revision;
      next.nodes = Object.fromEntries(
        p.graph.nodes.map((n: any) => [
          n.nodeId,
          next.nodes[n.nodeId]?.generation === n.generation
            ? next.nodes[n.nodeId]
            : {
                status: "pending",
                generation: n.generation,
                iteration: next.nodes[n.nodeId]?.iteration ?? 0,
              },
        ]),
      );
      break;
    case "node.status": {
      const old = next.nodes[p.nodeId];
      if (old?.generation !== p.generation)
        throw new Error("Unknown node generation");
      next.nodes[p.nodeId] = {
        ...old,
        ...p,
        ...(p.status === "running" && !old.startedAt
          ? { startedAt: event.timestamp }
          : {}),
        ...(["completed", "failed", "blocked", "cancelled"].includes(p.status)
          ? { endedAt: event.timestamp }
          : {}),
      };
      break;
    }
    case "route.selected":
      if (next.nodes[p.nodeId])
        next.nodes[p.nodeId] = {
          ...next.nodes[p.nodeId],
          modelId: p.modelId,
          connectionId: p.connectionId,
          rationale: p.reason,
        };
      break;
    case "invocation.started":
      next.attempts++;
      if (
        next.nodes[p.nodeId] &&
        (p.role === "worker" || !next.nodes[p.nodeId].modelId)
      )
        next.nodes[p.nodeId] = {
          ...next.nodes[p.nodeId],
          modelId: p.modelId,
          connectionId: p.connectionId,
        };
      break;
    case "runtime.elapsed":
      next.activeMs += p.ms;
      break;
    case "command.applied":
      next.commands = { ...next.commands, [p.commandId]: p.result };
      break;
  }
  return next;
}

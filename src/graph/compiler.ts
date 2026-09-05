import { isAbsolute } from "node:path";
import { RalphError } from "../util.js";
import {
  validateGraph,
  type GraphRevision,
  type NodeSpec,
  type RunBudget,
} from "./schema.js";

export interface GraphEnvelope {
  readPaths: string[];
  writePaths: string[];
  exclude: string[];
  verifierIds: string[];
  budget: RunBudget;
  capabilities?: string[];
}
export function normalizePattern(path: string): string {
  const p = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !p ||
    isAbsolute(p) ||
    /^[A-Za-z]:/.test(p) ||
    p
      .split("/")
      .some(
        (x) => x === ".." || x.toLowerCase() === ".git" || x.includes(":"),
      ) ||
    /[\0\r\n]/.test(p)
  )
    throw new RalphError(
      `Unsafe workspace path: ${path}`,
      "scope_violation",
      4,
    );
  return p;
}
export function matches(path: string, pattern: string): boolean {
  const p = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  const regex = p
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(
    "^" + regex + "$",
    process.platform === "win32" ? "i" : "",
  ).test(path.replaceAll("\\", "/"));
}
export function covered(path: string, allowed: string[]): boolean {
  return allowed.some(
    (p) =>
      p === "**" ||
      p === path ||
      (!path.includes("*") && matches(path, p)) ||
      (p.endsWith("/**") && path.startsWith(p.slice(0, -2))),
  );
}
export function overlap(a: string, b: string): boolean {
  if (process.platform === "win32") {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  if (a === b || a === "**" || b === "**") return true;
  const prefix = (x: string) => x.split("*")[0]!;
  return (
    prefix(a).startsWith(prefix(b)) ||
    prefix(b).startsWith(prefix(a)) ||
    matches(a, b) ||
    matches(b, a)
  );
}
export function topological(graph: GraphRevision): string[] {
  const degree = new Map(graph.nodes.map((n) => [n.nodeId, 0]));
  for (const e of graph.edges) degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  const ready = graph.nodes
    .filter((n) => degree.get(n.nodeId) === 0)
    .map((n) => n.nodeId);
  const result: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    result.push(id);
    for (const e of graph.edges.filter((e) => e.from === id)) {
      degree.set(e.to, degree.get(e.to)! - 1);
      if (degree.get(e.to) === 0) ready.push(e.to);
    }
  }
  if (result.length !== graph.nodes.length)
    throw new RalphError("Graph contains a cycle", "invalid_graph", 4);
  return result;
}
export function descendants(graph: GraphRevision, id: string): Set<string> {
  const found = new Set<string>();
  const visit = (x: string) => {
    for (const e of graph.edges.filter((e) => e.from === x))
      if (!found.has(e.to)) {
        found.add(e.to);
        visit(e.to);
      }
  };
  visit(id);
  return found;
}
export function artifactAncestors(
  graph: GraphRevision,
  nodeId: string,
): Set<string> {
  const found = new Set<string>();
  const visit = (id: string) => {
    for (const e of graph.edges.filter(
      (e) => e.to === id && e.kind === "artifact",
    ))
      if (!found.has(e.from)) {
        found.add(e.from);
        visit(e.from);
      }
  };
  visit(nodeId);
  return found;
}
export function compileGraph(
  input: unknown,
  envelope: GraphEnvelope,
): GraphRevision {
  const graph = structuredClone(validateGraph(input));
  if (
    graph.revision > envelope.budget.maxRevisions ||
    graph.nodes.length > envelope.budget.maxTotalNodes
  )
    throw new RalphError("Graph budget exceeded", "budget_exhausted", 10);
  if (
    graph.reason !== "repair" &&
    graph.nodes.some((n) => n.nodeId === "repair")
  )
    throw new RalphError(
      "Node ID repair is reserved for runtime repair",
      "invalid_graph",
      4,
    );
  const ids = new Set(graph.nodes.map((n) => n.nodeId));
  if (!graph.nodes.length)
    throw new RalphError("Graph is empty", "invalid_graph", 4);
  if (ids.size !== graph.nodes.length)
    throw new RalphError("Duplicate node ID", "invalid_graph", 4);
  if (graph.nodes.length > envelope.budget.maxNodes)
    throw new RalphError("Graph node budget exceeded", "budget_exhausted", 10);
  const edges = new Set<string>();
  for (const e of graph.edges) {
    if (!ids.has(e.from) || !ids.has(e.to))
      throw new RalphError("Unknown dependency", "invalid_graph", 4);
    const key = `${e.from}:${e.to}`;
    if (edges.has(key))
      throw new RalphError("Duplicate dependency", "invalid_graph", 4);
    edges.add(key);
  }
  topological(graph);
  for (const n of graph.nodes) {
    for (const p of n.readPaths)
      if (!covered(normalizePattern(p), envelope.readPaths))
        throw new RalphError(
          `Read outside approval: ${p}`,
          "scope_violation",
          4,
        );
    for (const p of n.writePaths) {
      normalizePattern(p);
      if (!covered(p, envelope.writePaths))
        throw new RalphError(
          `Write outside approval: ${p}`,
          "scope_violation",
          4,
        );
      if (envelope.exclude.some((x) => covered(p, [x])))
        throw new RalphError(`Excluded write: ${p}`, "scope_violation", 4);
    }
    if (n.kind === "read" && n.writePaths.length)
      throw new RalphError("Read nodes cannot write", "scope_violation", 4);
    if (n.inputArtifacts.length)
      throw new RalphError(
        "Initial graph artifact references must come from dependency edges",
        "invalid_graph",
        4,
      );
    if (n.verifierIds.some((x) => !envelope.verifierIds.includes(x)))
      throw new RalphError("Unknown verifier", "invalid_graph", 4);
    if (n.kind === "worker" && !n.verifierIds.length)
      throw new RalphError("Worker requires verification", "invalid_graph", 4);
    if (
      n.requiredCapabilities.some(
        (x) => !(envelope.capabilities ?? []).includes(x),
      )
    )
      throw new RalphError(
        "Required capability unavailable",
        "capability_gap",
        10,
      );
  }
  const writers = graph.nodes.filter((n) => n.kind === "worker");
  if (writers.length) {
    const integrators = graph.nodes.filter((n) => n.kind === "integrate"),
      validators = graph.nodes.filter((n) => n.kind === "validate");
    if (
      integrators.length !== 1 ||
      validators.length !== 1 ||
      !graph.edges.some(
        (e) =>
          e.from === integrators[0]!.nodeId && e.to === validators[0]!.nodeId,
      ) ||
      writers.some(
        (n) => !artifactAncestors(graph, integrators[0]!.nodeId).has(n.nodeId),
      )
    )
      throw new RalphError(
        "Every worker must reach one integration and final validation node",
        "invalid_graph",
        4,
      );
  }
  for (let a = 0; a < writers.length; a++)
    for (let b = a + 1; b < writers.length; b++) {
      const x = writers[a]!,
        y = writers[b]!;
      if (
        x.writePaths.some((p) => y.writePaths.some((q) => overlap(p, q))) &&
        !descendants(graph, x.nodeId).has(y.nodeId) &&
        !descendants(graph, y.nodeId).has(x.nodeId)
      )
        graph.edges.push({ from: x.nodeId, to: y.nodeId, kind: "artifact" });
    }
  topological(graph);
  for (const n of writers)
    if (
      ![...descendants(graph, n.nodeId)].some(
        (id) => graph.nodes.find((x) => x.nodeId === id)?.kind === "validate",
      )
    )
      throw new RalphError(
        `Worker ${n.nodeId} does not reach final validation`,
        "invalid_graph",
        4,
      );
  return graph;
}
export function singleGraph(
  runId: string,
  task: Omit<NodeSpec, "nodeId" | "kind" | "generation">,
): GraphRevision {
  return {
    schemaVersion: 1,
    runId,
    revision: 1,
    reason: "initial",
    nodes: [
      { ...task, nodeId: "work", generation: 0, kind: "worker" },
      {
        ...task,
        nodeId: "integrate",
        generation: 0,
        kind: "integrate",
        writePaths: [],
      },
      {
        ...task,
        nodeId: "validate",
        generation: 0,
        kind: "validate",
        writePaths: [],
      },
    ],
    edges: [
      { from: "work", to: "integrate", kind: "artifact" },
      { from: "integrate", to: "validate", kind: "artifact" },
    ],
  };
}

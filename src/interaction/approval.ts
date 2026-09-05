import type { ProjectConfig, TaskContract } from "../types.js";
import type { ContextSnapshot } from "../context/snapshot.js";
import {
  validateBudget,
  digest,
  type GraphRevision,
  type RunBudget,
} from "../graph/schema.js";
import { compileGraph, type GraphEnvelope } from "../graph/compiler.js";
import { RalphError } from "../util.js";
export interface ExecutionPlan {
  schemaVersion: 2;
  runId: string;
  mode: "answer" | "single" | "graph";
  projectRoot: string;
  baseHead: string;
  baseBranch: string;
  context: ContextSnapshot;
  contract: TaskContract;
  config: ProjectConfig;
  graph: GraphRevision;
  envelope: GraphEnvelope;
  budget: RunBudget;
  originRunId?: string;
  approvedHash?: string;
  approvedAt?: string;
}
export function planHash(plan: ExecutionPlan): string {
  const { approvedHash, approvedAt, ...unsigned } = plan;
  return digest(unsigned);
}
export function approvePlan(plan: ExecutionPlan): ExecutionPlan {
  validateBudget(plan.budget);
  compileGraph(plan.graph, plan.envelope);
  if (plan.mode === "answer" && plan.graph.nodes.some((n) => n.kind !== "read"))
    throw new RalphError(
      "Answer mode must be read only",
      "approval_required",
      10,
    );
  if (plan.graph.runId !== plan.runId)
    throw new RalphError("Run identity mismatch", "approval_required", 10);
  return {
    ...plan,
    approvedHash: planHash(plan),
    approvedAt: new Date().toISOString(),
  };
}
export function assertPlanApproved(plan: ExecutionPlan): void {
  validateBudget(plan.budget);
  if (
    plan.schemaVersion !== 2 ||
    !plan.approvedHash ||
    plan.approvedHash !== planHash(plan)
  )
    throw new RalphError(
      "Review and approve the exact v0.3 execution plan",
      "approval_required",
      10,
    );
  if (
    plan.graph.runId !== plan.runId ||
    (plan.mode === "answer" && plan.graph.nodes.some((n) => n.kind !== "read"))
  )
    throw new RalphError(
      "Execution mode or identity mismatch",
      "approval_required",
      10,
    );
  if (digest(plan.budget) !== digest(plan.envelope.budget))
    throw new RalphError("Budget mismatch", "approval_required", 10);
  if (digest(compileGraph(plan.graph, plan.envelope)) !== digest(plan.graph))
    throw new RalphError("Graph is not compiled", "invalid_graph", 4);
}

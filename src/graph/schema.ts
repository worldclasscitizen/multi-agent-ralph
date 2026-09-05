import { Type, type Static } from "@sinclair/typebox";
import Ajv from "ajv";
import { TASK_TYPES } from "../types.js";
import { RalphError, sha256 } from "../util.js";

const id = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$" });
const strings = Type.Array(Type.String());
const positive = Type.Integer({ minimum: 1 });
const object = { additionalProperties: false } as const;
export const RunBudgetSchema = Type.Object(
  {
    concurrency: positive,
    connectionConcurrency: positive,
    maxNodes: positive,
    maxTotalNodes: positive,
    maxRevisions: positive,
    maxRepairs: Type.Integer({ minimum: 0 }),
    maxAttempts: positive,
    activeMs: positive,
  },
  object,
);
export type RunBudget = Static<typeof RunBudgetSchema>;
export const DEFAULT_BUDGET: RunBudget = {
  concurrency: 4,
  connectionConcurrency: 1,
  maxNodes: 32,
  maxTotalNodes: 64,
  maxRevisions: 8,
  maxRepairs: 2,
  maxAttempts: 256,
  activeMs: 7_200_000,
};
export const NodeSchema = Type.Object(
  {
    nodeId: id,
    generation: Type.Integer({ minimum: 0 }),
    kind: Type.Union(
      ["worker", "read", "integrate", "validate"].map((x) => Type.Literal(x)),
    ),
    taskType: Type.Union(TASK_TYPES.map((x) => Type.Literal(x))),
    goal: Type.String({ minLength: 1 }),
    readPaths: strings,
    writePaths: strings,
    acceptanceCriteria: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
    }),
    requiredCapabilities: strings,
    inputArtifacts: strings,
    verifierIds: strings,
    budget: Type.Object(
      { maxIterations: Type.Integer({ minimum: 1, maximum: 6 }) },
      object,
    ),
  },
  object,
);
export type NodeSpec = Static<typeof NodeSchema>;
export const GraphSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runId: id,
    revision: positive,
    parentRevision: Type.Optional(positive),
    reason: Type.Union(
      ["initial", "expansion", "repair"].map((x) => Type.Literal(x)),
    ),
    nodes: Type.Array(NodeSchema),
    edges: Type.Array(
      Type.Object(
        {
          from: id,
          to: id,
          kind: Type.Union([Type.Literal("artifact"), Type.Literal("order")]),
        },
        object,
      ),
    ),
  },
  object,
);
export type GraphRevision = Static<typeof GraphSchema>;
export type NodeStatus =
  | "pending"
  | "queued"
  | "running"
  | "verifying"
  | "retry_wait"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type GraphRunStatus =
  | "planning"
  | "awaiting_input"
  | "ready"
  | "running"
  | "stopping"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
export interface NodeResult {
  nodeId: string;
  generation: number;
  inputDigest: string;
  outcome: "completed" | "blocked" | "failed" | "cancelled";
  artifactIds: string[];
  evidenceIds: string[];
  outputHead?: string;
  inputHead?: string;
  workspace?: string;
  summary: string;
}
export interface NodeState {
  modelId?: string;
  connectionId?: string;
  rationale?: string;
  status: NodeStatus;
  generation: number;
  iteration: number;
  startedAt?: string;
  endedAt?: string;
  result?: NodeResult;
  error?: string;
}
export interface GraphRunState {
  schemaVersion: 2;
  runId: string;
  status: GraphRunStatus;
  revision: number;
  seq: number;
  nodes: Record<string, NodeState>;
  attempts: number;
  activeMs: number;
  startedAt: string;
  updatedAt: string;
  resultHead?: string;
  message?: string;
  commands: Record<string, unknown>;
}
export type RunEvent =
  | {
      type: "run.status";
      payload: {
        status: GraphRunStatus;
        message?: string;
        resultHead?: string;
      };
    }
  | { type: "graph.revised"; payload: { graph: GraphRevision } }
  | {
      type: "node.status";
      payload: {
        nodeId: string;
        generation: number;
        status: NodeStatus;
        iteration?: number;
        error?: string;
        result?: NodeResult;
      };
    }
  | {
      type: "invocation.started";
      payload: {
        invocationId: string;
        attemptId: string;
        generation?: number;
        iteration?: number;
        nodeId: string;
        connectionId: string;
        modelId: string;
        role: string;
      };
    }
  | {
      type: "invocation.reconciled";
      payload: {
        attemptId: string;
        artifactId: string;
        processStopped: true;
        inspectionDigest: string;
      };
    }
  | {
      type: "invocation.finished";
      payload: {
        attemptId: string;
        generation?: number;
        iteration?: number;
        nodeId: string;
        connectionId: string;
        modelId: string;
        durationMs: number;
        usage?: import("../types.js").AgentUsage;
        error?: string;
      };
    }
  | {
      type: "route.selected";
      payload: {
        nodeId: string;
        connectionId: string;
        modelId: string;
        reason: string;
      };
    }
  | { type: "runtime.elapsed"; payload: { ms: number } }
  | { type: "command.applied"; payload: { commandId: string; result: unknown } }
  | {
      type: "evidence.saved";
      payload: { nodeId: string; artifactId: string; summary: string };
    }
  | {
      type: "circuit.changed";
      payload: { key: string; retryAt: number; reason: string };
    }
  | { type: "question.created"; payload: { question: unknown } };
export type EventEnvelope = RunEvent & {
  nodeId?: string;
  generation?: number;
  iteration?: number;
  attemptId?: string;
  schemaVersion: 2;
  eventId: string;
  runId: string;
  seq: number;
  graphRevision: number;
  timestamp: string;
  previousHash: string;
  hash: string;
};
const ajv = new Ajv.default({ allErrors: true, strict: false });
const graphValidator = ajv.compile(GraphSchema);
const budgetValidator = ajv.compile(RunBudgetSchema);
export function validateGraph(value: unknown): GraphRevision {
  if (!graphValidator(value))
    throw new RalphError(
      ajv.errorsText(graphValidator.errors),
      "invalid_graph",
      4,
    );
  return value as GraphRevision;
}
export function validateBudget(value: unknown): RunBudget {
  if (!budgetValidator(value))
    throw new RalphError(
      ajv.errorsText(budgetValidator.errors),
      "invalid_budget",
      4,
    );
  return value as RunBudget;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown): string {
  return sha256(canonical(value));
}
export function safeId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value))
    throw new RalphError("Invalid identifier", "invalid_id", 4);
  return value;
}

const NodeResultSchema = Type.Object(
  {
    nodeId: id,
    generation: Type.Integer({ minimum: 0 }),
    inputDigest: Type.String(),
    outcome: Type.Union(
      ["completed", "blocked", "failed", "cancelled"].map((x) =>
        Type.Literal(x),
      ),
    ),
    artifactIds: strings,
    evidenceIds: strings,
    outputHead: Type.Optional(Type.String()),
    inputHead: Type.Optional(Type.String()),
    workspace: Type.Optional(Type.String()),
    summary: Type.String(),
  },
  object,
);
const UsageSchema = Type.Object(
  Object.fromEntries(
    [
      "inputTokens",
      "outputTokens",
      "cachedTokens",
      "reasoningTokens",
      "totalTokens",
      "estimatedCostUsd",
      "contextWindowTokens",
    ].map((k) => [k, Type.Optional(Type.Number({ minimum: 0 }))]),
  ),
  object,
);
const payloads = {
  "run.status": Type.Object(
    {
      status: Type.Union(
        [
          "planning",
          "awaiting_input",
          "ready",
          "running",
          "stopping",
          "paused",
          "completed",
          "failed",
          "cancelled",
        ].map((x) => Type.Literal(x)),
      ),
      message: Type.Optional(Type.String()),
      resultHead: Type.Optional(Type.String()),
    },
    object,
  ),
  "graph.revised": Type.Object({ graph: GraphSchema }, object),
  "node.status": Type.Object(
    {
      nodeId: id,
      generation: Type.Integer({ minimum: 0 }),
      status: Type.Union(
        [
          "pending",
          "queued",
          "running",
          "verifying",
          "retry_wait",
          "blocked",
          "completed",
          "failed",
          "cancelled",
          "interrupted",
        ].map((x) => Type.Literal(x)),
      ),
      iteration: Type.Optional(Type.Integer({ minimum: 0, maximum: 6 })),
      error: Type.Optional(Type.String()),
      result: Type.Optional(NodeResultSchema),
    },
    object,
  ),
  "invocation.started": Type.Object(
    {
      invocationId: Type.String(),
      attemptId: Type.String(),
      generation: Type.Optional(Type.Integer({ minimum: 0 })),
      iteration: Type.Optional(Type.Integer({ minimum: 0 })),
      nodeId: id,
      connectionId: Type.String(),
      modelId: Type.String(),
      role: Type.String(),
    },
    object,
  ),
  "invocation.reconciled": Type.Object(
    {
      attemptId: Type.String(),
      artifactId: Type.String(),
      processStopped: Type.Literal(true),
      inspectionDigest: Type.String(),
    },
    object,
  ),
  "invocation.finished": Type.Object(
    {
      attemptId: Type.String(),
      generation: Type.Optional(Type.Integer({ minimum: 0 })),
      iteration: Type.Optional(Type.Integer({ minimum: 0 })),
      nodeId: id,
      connectionId: Type.String(),
      modelId: Type.String(),
      durationMs: Type.Number({ minimum: 0 }),
      usage: Type.Optional(UsageSchema),
      error: Type.Optional(Type.String()),
    },
    object,
  ),
  "route.selected": Type.Object(
    {
      nodeId: id,
      connectionId: Type.String(),
      modelId: Type.String(),
      reason: Type.String(),
    },
    object,
  ),
  "runtime.elapsed": Type.Object({ ms: Type.Number({ minimum: 0 }) }, object),
  "command.applied": Type.Object(
    {
      commandId: Type.String(),
      result: Type.Object(
        {
          accepted: Type.Optional(Type.Boolean()),
          error: Type.Optional(Type.String()),
          finalApproval: Type.Optional(Type.Boolean()),
          note: Type.Optional(Type.String()),
        },
        object,
      ),
    },
    object,
  ),
  "evidence.saved": Type.Object(
    {
      nodeId: id,
      artifactId: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      summary: Type.String(),
    },
    object,
  ),
  "circuit.changed": Type.Object(
    {
      key: Type.String(),
      retryAt: Type.Number({ minimum: 0 }),
      reason: Type.String(),
    },
    object,
  ),
  "question.created": Type.Object(
    {
      question: Type.Object(
        {
          id: Type.String(),
          runId: Type.String(),
          reason: Type.String(),
          questions: Type.Array(
            Type.Object(
              {
                id: Type.String(),
                prompt: Type.String(),
                options: Type.Optional(strings),
                required: Type.Boolean(),
                defaultValue: Type.Optional(Type.String()),
              },
              object,
            ),
            { minItems: 1, maxItems: 3 },
          ),
          blocksExecution: Type.Boolean(),
        },
        object,
      ),
    },
    object,
  ),
};
const eventValidators = Object.fromEntries(
  Object.entries(payloads).map(([k, v]) => [k, ajv.compile(v)]),
);
export function validateRunEvent(event: RunEvent): void {
  const validate = eventValidators[event.type];
  if (!validate || !validate(event.payload))
    throw new RalphError(
      `Invalid event: ${event.type}: ${validate ? ajv.errorsText(validate.errors) : "unknown type"}`,
      "invalid_event",
      4,
    );
}

export const TASK_TYPES = [
  "planning_architecture",
  "frontend_visual",
  "backend_core",
  "tdd_debugging",
  "static_review",
  "delivery_evidence",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];
export type ExecutionProfile = "balanced" | "quality" | "fast" | "budget";
export type RiskTier = "T0" | "T1" | "T2" | "T3";
export type SessionPolicy = "fresh" | "continue";
export type RouteMode = "adaptive" | "fixed";
export type AgentRole =
  | "contractPlanner"
  | "router"
  | "critic"
  | "metaPrompter"
  | "worker"
  | "adjudicator";

export interface TaskContract {
  id: string;
  taskType: TaskType;
  goal: string;
  include: string[];
  exclude: string[];
  requirements: string[];
  acceptanceCriteria: string[];
  verifierCommands: string[];
  requiredArtifacts: string[];
  attachments: string[];
  constraints: string[];
  executionProfile: ExecutionProfile;
  projectRoot: string;
  riskTier?: RiskTier;
  modelOverride?: string;
  initialRouteDecision?: RouteDecision;
  routeSnapshot?: ProjectConfig["routes"];
  routePolicySnapshot?: ProjectConfig["routePolicies"];
  approvedCatalogVersion?: number;
  approvedHash?: string;
  approvedAt?: string;
}

export interface ProviderDetection {
  installed: boolean;
  executable?: string;
  version?: string;
  detail?: string;
}

export interface AuthStatus {
  status: "authenticated" | "unauthenticated" | "unknown" | "unavailable";
  method?: "builtin" | "api_key" | "process";
  accountLabel?: string;
  detail?: string;
}

export interface ModelDescriptor {
  connectionId: string;
  provider: string;
  modelId: string;
  displayName: string;
  mode: "builtin" | "api" | "process";
  reasoningEffort?: string;
}

export interface AgentRequest {
  compactPrompt?: string;
  generation?: number;
  iteration?: number;
  runId: string;
  nodeId: string;
  role: AgentRole;
  model: ModelDescriptor;
  projectRoot: string;
  prompt: string;
  sessionId?: string;
  tools?: ToolDefinition[];
  writePaths?: string[];
  excludePaths?: string[];
  readPaths?: string[];
}

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  contextWindowTokens?: number;
}

export interface AgentResult {
  text: string;
  exitCode: number;
  sessionId?: string;
  usage?: AgentUsage;
  rawModelId?: string;
  usageCumulative?: boolean;
  error?: ProviderError;
}

export type ProviderErrorKind =
  | "context_overflow"
  | "rate_limit"
  | "quota"
  | "timeout"
  | "server_error"
  | "overloaded"
  | "empty_response"
  | "schema_error"
  | "authentication"
  | "invalid_request"
  | "policy_denial"
  | "unavailable"
  | "unknown";

export interface ProviderError {
  kind: ProviderErrorKind;
  message: string;
  retryable: boolean;
  statusCode?: number;
  retryAfterMs?: number;
  evidencePath?: string;
}

export interface SessionHandle {
  id: string;
  provider: string;
}

export interface CapacityWindow {
  label: string;
  remainingPercent: number;
  resetsAt?: string;
}

export type CapacitySnapshot =
  | {
      kind: "subscription";
      status: "exact" | "unavailable" | "auth_required" | "stale";
      windows?: CapacityWindow[];
      fetchedAt: string;
      source: string;
      detail?: string;
    }
  | {
      kind: "api_balance";
      status: "exact" | "unavailable" | "auth_required" | "stale";
      balances?: Array<{
        currency: string;
        total: string;
        granted?: string;
        toppedUp?: string;
      }>;
      fetchedAt: string;
      source: string;
      detail?: string;
    };

export interface ProviderAdapter {
  id: string;
  mode: "builtin" | "api" | "process";
  detect(): Promise<ProviderDetection>;
  authStatus(): Promise<AuthStatus>;
  listModels(): Promise<ModelDescriptor[]>;
  invoke(request: AgentRequest, signal: AbortSignal): Promise<AgentResult>;
  interrupt?(handle: SessionHandle): Promise<void>;
  capacity?(): Promise<CapacitySnapshot>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CatalogModel {
  qualityTier?: "unrated" | "measured";
  checkedAt?: string;
  provider: string;
  adapter: string;
  modelId: string;
  displayName: string;
  releasedAt?: string;
  expiresAt: string;
  capabilities: {
    reasoning: number | null;
    coding: number | null;
    structuredOutput: boolean;
    vision: boolean;
    toolUse: boolean;
    longContext: boolean;
  };
  taskAffinity: Record<TaskType, number | null>;
  costTier: number | null;
  latencyTier: number | null;
  reliabilityBaseline: number | null;
  supportedEfforts: string[];
  recommendedEffort: string;
  evidence: Array<{ source: string; checkedAt: string }>;
}

export interface ModelCatalog {
  schemaVersion: 1 | 2;
  keyId?: string;
  version: number;
  generatedAt: string;
  models: CatalogModel[];
}

export interface ConnectionConfig {
  id: string;
  adapter: string;
  provider: string;
  enabled: boolean;
  mode: "builtin" | "api" | "process";
  apiKeyEnv?: string;
  baseUrl?: string;
  command?: string[];
  models?: string[];
}

export interface RouteEntry {
  connectionId: string;
  provider: string;
  modelId: string;
  displayName: string;
  reasoningEffort: string;
  score: number;
  qualityScore?: number;
  latencyScore?: number;
  costScore?: number;
  source: "automatic" | "override";
  degradedCapabilities?: string[];
}

export interface RoutePolicy {
  mode: RouteMode;
  candidates?: RouteEntry[];
  hardPin?: {
    connectionId: string;
    modelId: string;
    reasoningEffort?: string;
  };
}

export interface RouteDecision {
  boundary:
    | "contract_approval"
    | "iteration_start"
    | "failure"
    | "boundary_adjudication";
  taskType: TaskType;
  riskTier: RiskTier;
  connectionId: string;
  provider: string;
  modelId: string;
  displayName: string;
  reasoningEffort: string;
  sessionPolicy: SessionPolicy;
  verificationTier: RiskTier;
  rationale: string;
  source: "hard_pin" | "online_router" | "deterministic_fallback";
  decidedAt: string;
  policyHash: string;
}

export interface GuardrailRecord {
  timestamp: string;
  runId: string;
  taskType: TaskType;
  lesson: string;
  evidence: string[];
  failureFingerprint?: string;
}

export interface EvidencePacket {
  schemaVersion: 1;
  runId: string;
  iteration: number;
  taskType: TaskType;
  riskTier: RiskTier;
  contractHash: string;
  policyHash: string;
  baseHead: string;
  currentHead: string;
  gitStatus: string;
  diffSummary: string;
  routeDecision: RouteDecision;
  verifier?: {
    ok: boolean;
    exitCode: number;
    summary: string;
    gates?: Array<{
      id: string;
      status: "pass" | "fail" | "not_applicable";
      evidence: string[];
    }>;
  };
  critic?: CriticAssessment;
  failureFingerprint?: string;
  guardrails: GuardrailRecord[];
  unresolvedItems: string[];
  createdAt: string;
}

export interface ProjectConfig {
  operationalMeasurements?: import("./gateway/measurements.js").OperationalMeasurement[];
  schemaVersion: 1;
  projectRoot: string;
  preset: ExecutionProfile;
  initializedAt: string;
  connections: ConnectionConfig[];
  routes: Record<TaskType | AgentRole, RouteEntry[]>;
  overrides: Partial<Record<TaskType | AgentRole, RouteEntry[]>>;
  routePolicies?: Partial<Record<TaskType | AgentRole, RoutePolicy>>;
  verifierCommands: string[];
  verification?: {
    frozenInvariants: string[];
    coverageBaseline?: {
      lines?: number;
      branches?: number;
      functions?: number;
    };
  };
  catalogVersion: number;
}

export type RunVerdict =
  | "running"
  | "pass"
  | "retry"
  | "needs_operator"
  | "failed"
  | "interrupted"
  | "interrupted_partial";

export interface RunState {
  id: string;
  projectRoot: string;
  contractId: string;
  taskType: TaskType;
  status: RunVerdict;
  iteration: number;
  maxIterations: number;
  currentNode?: string;
  startedAt: string;
  endedAt?: string;
  pid: number;
  catalogVersion: number;
  routes: ProjectConfig["routes"];
  score?: number;
  verdict?: RunVerdict;
  lastCheckpoint?: string;
  stopRequested?: boolean;
  riskTier?: RiskTier;
  lastRouteDecision?: RouteDecision;
  lastWorkerContextUtilization?: number;
  workerContinuationCount?: number;
}

export interface RalphEvent {
  timestamp: string;
  runId: string;
  type: string;
  node?: string;
  status?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface CriterionAssessment {
  id: string;
  level: "absent" | "partial" | "verified" | "complete";
  evidence: string[];
  explanation?: string;
}

export interface CriticAssessment {
  criteria: CriterionAssessment[];
  hardGates: Array<{
    id: string;
    status: "pass" | "fail" | "unknown";
    evidence: string[];
  }>;
  findings: Array<{
    severity: "low" | "medium" | "high" | "critical";
    summary: string;
    evidence: string[];
  }>;
}

export interface EvaluationResult {
  score: number;
  verdict: "pass" | "retry" | "needs_operator";
  hardGateFailures: string[];
  hardGateUnknown: string[];
  criterionScores: Record<string, number>;
  reason: string;
}

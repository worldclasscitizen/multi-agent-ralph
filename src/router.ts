import type {
  AgentRole,
  CatalogModel,
  ConnectionConfig,
  ExecutionProfile,
  ModelCatalog,
  ProjectConfig,
  RouteEntry,
  TaskType,
} from "./types.js";
import { TASK_TYPES } from "./types.js";

const ROLE_TASK: Record<AgentRole, TaskType> = {
  contractPlanner: "planning_architecture",
  router: "planning_architecture",
  critic: "static_review",
  metaPrompter: "planning_architecture",
  worker: "backend_core",
  adjudicator: "static_review",
};

const WEIGHTS: Record<
  ExecutionProfile,
  {
    fit: number;
    reliability: number;
    diversity: number;
    speed: number;
    cost: number;
  }
> = {
  balanced: {
    fit: 0.5,
    reliability: 0.25,
    diversity: 0.15,
    speed: 0.05,
    cost: 0.05,
  },
  quality: { fit: 0.7, reliability: 0.2, diversity: 0.1, speed: 0, cost: 0 },
  fast: { fit: 0.35, reliability: 0.15, diversity: 0, speed: 0.45, cost: 0.05 },
  budget: {
    fit: 0.35,
    reliability: 0.15,
    diversity: 0,
    speed: 0.05,
    cost: 0.45,
  },
};

function scoreModel(
  model: CatalogModel,
  task: TaskType,
): { quality: number; speed: number; cost: number } {
  // Zero is an internal tie key for unrated entries, never a claimed measurement.
  if (model.qualityTier === "unrated") return { quality: 0, speed: 0, cost: 0 };
  const fit =
    model.taskAffinity[task] ??
    ((model.capabilities.coding ?? 0) + (model.capabilities.reasoning ?? 0)) /
      2;
  const speed =
    model.latencyTier === null ? 0 : Math.max(0, 100 - model.latencyTier * 20);
  const cost =
    model.costTier === null ? 0 : Math.max(0, 100 - model.costTier * 20);
  return {
    quality: Number(
      (fit * 0.75 + (model.reliabilityBaseline ?? 0) * 0.25).toFixed(2),
    ),
    speed,
    cost,
  };
}

function supportsTask(model: CatalogModel, task: TaskType): boolean {
  if (task === "frontend_visual" || task === "delivery_evidence")
    return model.capabilities.vision;
  return true;
}

function connectionSupportsModel(
  connection: ConnectionConfig,
  model: CatalogModel,
): boolean {
  return connection.adapter === model.adapter;
}

function routeFor(
  catalog: ModelCatalog,
  connections: ConnectionConfig[],
  task: TaskType,
  preset: ExecutionProfile,
): RouteEntry[] {
  const now = Date.now();
  const allCandidates = catalog.models
    .filter((model) => Date.parse(model.expiresAt) >= now)
    .flatMap((model) =>
      connections
        .filter(
          (connection) =>
            connection.enabled && connectionSupportsModel(connection, model),
        )
        .filter(
          (connection) =>
            !connection.models || connection.models.includes(model.modelId),
        )
        .map((connection) => {
          const metrics = scoreModel(model, task);
          return {
            connectionId: connection.id,
            provider: model.provider,
            modelId: model.modelId,
            displayName: model.displayName,
            reasoningEffort: model.recommendedEffort,
            score: metrics.quality,
            qualityScore: metrics.quality,
            latencyScore: metrics.speed,
            costScore: metrics.cost,
            source: "automatic" as const,
            ...(supportsTask(model, task) && model.qualityTier !== "unrated"
              ? {}
              : {
                  degradedCapabilities: [
                    ...(!supportsTask(model, task) ? ["vision"] : []),
                    ...(model.qualityTier === "unrated"
                      ? ["unrated_model"]
                      : []),
                  ],
                }),
          };
        }),
    );
  const capable = allCandidates.filter(
    (candidate) => !candidate.degradedCapabilities?.includes("vision"),
  );
  const candidates = capable.length ? capable : allCandidates;

  const chosen: RouteEntry[] = [];
  const usedProviders = new Set<string>();
  const remaining = [...candidates];
  const maximumQuality = Math.max(
    ...remaining.map((item) => item.qualityScore ?? item.score),
  );
  while (chosen.length < 3 && remaining.length) {
    const diversityWeight = WEIGHTS[preset].diversity * 100;
    remaining.sort((a, b) => {
      const aBand = Math.max(
        0,
        Math.ceil((maximumQuality - (a.qualityScore ?? a.score)) / 2) - 1,
      );
      const bBand = Math.max(
        0,
        Math.ceil((maximumQuality - (b.qualityScore ?? b.score)) / 2) - 1,
      );
      if (aBand !== bBand) return aBand - bBand;
      const secondary = (item: RouteEntry) =>
        preset === "fast"
          ? (item.latencyScore ?? 0)
          : preset === "budget"
            ? (item.costScore ?? 0)
            : preset === "quality"
              ? (item.qualityScore ?? item.score)
              : (item.qualityScore ?? item.score) * 0.8 +
                (item.latencyScore ?? 0) * 0.1 +
                (item.costScore ?? 0) * 0.1;
      const aScore =
        secondary(a) +
        (chosen.length > 0 && !usedProviders.has(a.provider)
          ? diversityWeight
          : 0);
      const bScore =
        secondary(b) +
        (chosen.length > 0 && !usedProviders.has(b.provider)
          ? diversityWeight
          : 0);
      return (
        bScore - aScore ||
        (b.qualityScore ?? b.score) - (a.qualityScore ?? a.score) ||
        a.connectionId.localeCompare(b.connectionId) ||
        a.modelId.localeCompare(b.modelId)
      );
    });
    const candidate = remaining.shift()!;
    chosen.push(candidate);
    usedProviders.add(candidate.provider);
  }
  return chosen;
}

export function buildRoutes(
  catalog: ModelCatalog,
  connections: ConnectionConfig[],
  preset: ExecutionProfile,
  overrides: ProjectConfig["overrides"] = {},
): ProjectConfig["routes"] {
  const routes = {} as ProjectConfig["routes"];
  for (const task of TASK_TYPES)
    routes[task] =
      overrides[task] ?? routeFor(catalog, connections, task, preset);
  for (const role of [
    "contractPlanner",
    "router",
    "critic",
    "metaPrompter",
    "worker",
    "adjudicator",
  ] as AgentRole[]) {
    routes[role] =
      overrides[role] ??
      routeFor(catalog, connections, ROLE_TASK[role], preset);
  }
  return routes;
}

export function explainRoutes(config: ProjectConfig): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config.routes).map(([key, chain]) => [
      key,
      chain.map((entry, index) => ({
        order: index + 1,
        connection: entry.connectionId,
        model: entry.modelId,
        displayName: entry.displayName,
        effort: entry.reasoningEffort,
        qualityScore: entry.degradedCapabilities?.includes("unrated_model")
          ? null
          : (entry.qualityScore ?? entry.score),
        qualityTier: entry.degradedCapabilities?.includes("unrated_model")
          ? "unrated"
          : "measured",
        latencyScore: entry.latencyScore,
        costScore: entry.costScore,
        source: entry.source,
        ...(entry.degradedCapabilities?.length
          ? { degradedCapabilities: entry.degradedCapabilities }
          : {}),
      })),
    ]),
  );
}

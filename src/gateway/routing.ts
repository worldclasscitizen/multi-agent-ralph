import { rankMeasuredRoutes } from "./measurements.js";
import { verifierVersion } from "./history.js";
import type {
  ProjectConfig,
  TaskContract,
  RouteEntry,
  AgentRole,
} from "../types.js";
import { candidateRoutes, roleRoutes } from "../policy.js";
import { RalphError } from "../util.js";
export function routesFor(
  config: ProjectConfig,
  contract: TaskContract,
  role: AgentRole,
): { routes: RouteEntry[]; hardPin: boolean } {
  const policy =
    role === "worker"
      ? config.routePolicies?.worker?.hardPin
        ? config.routePolicies.worker
        : config.routePolicies?.[contract.taskType]
      : config.routePolicies?.[role];
  let routes =
    role === "worker"
      ? candidateRoutes(config, contract)
      : roleRoutes(config, role);
  const pin = policy?.hardPin;
  if (pin)
    routes = routes.filter(
      (r) => r.connectionId === pin.connectionId && r.modelId === pin.modelId,
    );
  if (role === "worker" && contract.modelOverride)
    routes = routes.filter((r) => r.modelId === contract.modelOverride);
  if (!routes.length)
    throw new RalphError(
      `No approved route for ${role}`,
      "model_unavailable",
      10,
    );
  if (
    role === "worker" &&
    !pin &&
    !contract.modelOverride &&
    policy?.mode !== "fixed"
  )
    routes = rankMeasuredRoutes(
      routes,
      config.operationalMeasurements ?? [],
      contract.taskType,
      contract.executionProfile,
      verifierVersion(config),
    );
  return {
    routes,
    hardPin: Boolean(pin || (role === "worker" && contract.modelOverride)),
  };
}

import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { task, graphFor } from "./live-fixture.mjs";
import { functionalRequest, assertFunctionalPlan, inspectFunctionalResult } from "./lib/live-functional.mjs";
const [version, root, runtime, mode, budgetPath, purpose, startingCalls, model, output] = process.argv.slice(2);
const load = name => import(pathToFileURL(join(runtime, "dist", name + ".js")).href);
const { saveConfig } = await load("state");
const { validateContract, approveContract } = await load("contracts");
const route = { connectionId: "release-codex", provider: "openai", modelId: model, displayName: model, mode: "builtin", reasoningEffort: "low", score: 0, source: "override" };
const roles = ["planning_architecture", "frontend_visual", "backend_core", "tdd_debugging", "static_review", "delivery_evidence", "contractPlanner", "critic", "metaPrompter", "worker", "adjudicator"];
const routes = Object.fromEntries(roles.map(role => [role, [route]]));
const policies = Object.fromEntries(roles.map(role => [role, { mode: "fixed", candidates: [route], hardPin: { connectionId: route.connectionId, modelId: model } }]));
const config = { schemaVersion: 1, projectRoot: root, preset: "balanced", initializedAt: new Date().toISOString(),
  connections: [{ id: route.connectionId, adapter: "generic-process", provider: "openai", enabled: true, mode: "process", command: [process.execPath, resolve("scripts/live-bridge.mjs"), mode, budgetPath, purpose, startingCalls, model] }],
  routes, routePolicies: policies, overrides: {}, verifierCommands: task.verifierCommands, catalogVersion: 3 };
await saveConfig(root, config);
let contract = validateContract(task, root), state, details;
if (version === "baseline") {
  contract = approveContract({ ...contract, routeSnapshot: routes, routePolicySnapshot: policies, approvedCatalogVersion: 3 });
  state = await (await load("orchestrator")).executeContract(root, contract);
} else {
  const { planRun } = await load("nodes/planner");
  const { approvePlan } = await load("interaction/approval");
  const { startRun } = await load("runtime/supervisor");
  if (version === "functional") {
    let plan;
    try {
    plan = await planRun(root, functionalRequest, { config });
    assertFunctionalPlan(plan);
    const { git } = await load("workspace/manager");
    if (await git(root, ["status", "--porcelain"])) throw new Error("Planning changed the fixture before approval");
    state = await startRun(approvePlan(plan));
    // Always preserve the actual terminal/pending state even if acceptance fails.
    await writeFile(output, JSON.stringify({ status: state.status, runId: state.runId, resultHead: state.resultHead ?? null, workerCount: plan.graph.nodes.filter(n => n.kind === "worker").length,
      nodes: plan.graph.nodes.map(n => ({ nodeId: n.nodeId, kind: n.kind, status: state.nodes[n.nodeId]?.status, iteration: state.nodes[n.nodeId]?.iteration })) }));
    const { RunStore } = await load("storage/run-store");
    const { statePaths } = await load("state");
    details = await inspectFunctionalResult(root, plan, state, new RunStore((await statePaths(root)).root, plan.runId));
    } catch (error) {
      if (!state) await writeFile(output, JSON.stringify({ status: error.question ? "awaiting_input" : "failed", runId: error.runId ?? plan?.runId, phase: plan ? "approval" : "planning", resultHead: null }));
      throw error;
    }
  } else state = await startRun(approvePlan(await planRun(root, task.goal, { contract, config, graph: graphFor(contract) })));
}
await writeFile(output, JSON.stringify({ status: state.status, runId: state.runId ?? state.id, resultHead: state.resultHead ?? null, ...details }));
if (!["completed", "pass"].includes(state.status)) process.exitCode = 1;

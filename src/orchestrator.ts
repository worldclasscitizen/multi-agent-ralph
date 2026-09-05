import { planRun, draftTask } from "./nodes/planner.js";
import { approvePlan } from "./interaction/approval.js";
import { startRun, resumeGraphRun } from "./runtime/supervisor.js";
import { loadConfig, statePaths, readEvents } from "./state.js";
import { ProviderGateway } from "./gateway/gateway.js";
import { BudgetCounter } from "./runtime/budget.js";
import { DEFAULT_BUDGET } from "./graph/schema.js";
import { RunStore } from "./storage/run-store.js";
import { makeId, RalphError } from "./util.js";
import type { TaskContract, RunState } from "./types.js";
/** Compatibility draft API; new integrations should use planRun. */
export async function draftContract(
  root: string,
  request: string,
  controller = new AbortController(),
): Promise<TaskContract> {
  const config = await loadConfig(root);
  const store = new RunStore((await statePaths(root)).root, makeId("draft"));
  await store.acquire();
  try {
    return await draftTask(
      root,
      request,
      config,
      new ProviderGateway(config, new BudgetCounter(DEFAULT_BUDGET), (e) =>
        store.append(e, 1),
      ),
      store.runId,
      controller.signal,
    );
  } finally {
    await store.release();
  }
}
/** v0.2 approvals cannot authorize a v0.3 graph. */
export async function executeContract(
  _root: string,
  _contract: TaskContract,
  _resume?: RunState,
): Promise<RunState> {
  throw new RalphError(
    "Use planRun, approvePlan and startRun; v0.2 approvals cannot authorize graphs",
    "migration_required",
    10,
  );
}
export async function approveAndExecute(root: string, contract: TaskContract) {
  return startRun(
    approvePlan(
      await planRun(root, contract.goal, { contract, mode: "single" }),
    ),
  );
}
export async function resumeRun(root: string, runId: string) {
  return resumeGraphRun(root, runId);
}
export async function recentProgress(root: string, id: string) {
  return (await readEvents(root, id))
    .slice(-20)
    .map((e) => e.message)
    .join("\n");
}

import { recoverOwner } from "./recovery.js";
import { ConnectionLimits } from "../gateway/limits.js";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  assertPlanApproved,
  planHash,
  type ExecutionPlan,
} from "../interaction/approval.js";
import { statePaths } from "../state.js";
import { RunStore } from "../storage/run-store.js";
import { durableWrite } from "../storage/journal.js";
import { schedule } from "../graph/scheduler.js";
import {
  artifactAncestors,
  topological,
  descendants,
  compileGraph,
} from "../graph/compiler.js";
import { reviseGraph } from "../graph/revisions.js";
import {
  digest,
  type NodeResult,
  type NodeSpec,
  type GraphRunState,
} from "../graph/schema.js";
import { ProviderGateway } from "../gateway/gateway.js";
import { routesFor } from "../gateway/routing.js";
import { BudgetCounter } from "./budget.js";
import { pendingCommands } from "./commands.js";
import {
  IntegrationConflict,
  WorkspaceManager,
  git,
} from "../workspace/manager.js";
import { deliverResult } from "../workspace/integration.js";
import { runRalphLoop } from "../loop/runner.js";
import { runVerifier } from "../verifier.js";
import { gitHead, gitStatus } from "../git.js";
import { classifyRisk } from "../policy.js";
import { criticPrompt } from "../prompts.js";
import { evaluateAssessment, validateAssessment } from "../evaluator.js";
import { parseJsonObject, RalphError, redact } from "../util.js";

export async function storeFor(
  projectRoot: string,
  runId: string,
): Promise<RunStore> {
  return new RunStore((await statePaths(projectRoot)).root, runId);
}
export async function startRun(
  approved: ExecutionPlan,
  options: { signal?: AbortSignal; resume?: boolean } = {},
): Promise<GraphRunState> {
  assertPlanApproved(approved);
  let plan = structuredClone(approved);
  const store = await storeFor(plan.projectRoot, plan.runId);
  if (options.resume) await recoverOwner(store.root);
  await store.acquire();
  let lastClock = Date.now();
  let clockActive = false;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  let commandLoop: Promise<void> = Promise.resolve();
  const stop = () =>
    controller.abort(new Error("Execution stopped; partial work is retained"));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await store.journal.read(true);
    let state = await store.state();
    if (["completed", "cancelled"].includes(state.status)) return state;
    try {
      const saved = JSON.parse(
        await readFile(join(store.directory, "plan.json"), "utf8"),
      ) as ExecutionPlan;
      if (planHash(saved) !== planHash(approved))
        throw new RalphError(
          "Saved plan changed after approval",
          "approval_required",
          10,
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (!options.resume && (await gitHead(plan.projectRoot)) !== plan.baseHead)
      throw new RalphError(
        "Project HEAD changed after planning",
        "approval_required",
        10,
      );
    if (!options.resume && (await gitStatus(plan.projectRoot)).trim())
      throw new RalphError(
        "Start requires a clean working tree",
        "dirty_worktree",
        3,
      );
    await durableWrite(
      join(store.directory, "plan.json"),
      JSON.stringify(plan),
    );
    if (!Object.keys(state.nodes).length)
      await store.append(
        { type: "graph.revised", payload: { graph: plan.graph } },
        1,
      );
    else plan.graph = compileGraph(await store.graph(), plan.envelope);
    const events = await store.readAfter();
    const finished = new Set(
      events
        .filter(
          (e) =>
            e.type === "invocation.finished" ||
            e.type === "invocation.reconciled",
        )
        .map((e) =>
          e.type === "invocation.finished" || e.type === "invocation.reconciled"
            ? e.payload.attemptId
            : "",
        ),
    );
    if (
      options.resume &&
      events.some(
        (e) =>
          e.type === "invocation.started" && !finished.has(e.payload.attemptId),
      )
    )
      throw new RalphError(
        "An invocation has no confirmed outcome. Inspect preserved work and process state before starting a new plan.",
        "uncertain_invocation",
        10,
      );
    const budget = new BudgetCounter(
      plan.budget,
      state.attempts,
      state.activeMs,
    );
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(budget.remainingMs()),
      ...(options.signal ? [options.signal] : []),
    ]);
    const gateway = new ProviderGateway(plan.config, budget, (event) =>
      store.append(event, plan.graph.revision),
    );
    for (const e of events)
      if (e.type === "circuit.changed")
        gateway.circuits.restore(e.payload.key, e.payload.retryAt);
    const verificationLimits = new ConnectionLimits(1);
    const manager = new WorkspaceManager(
      plan.projectRoot,
      store,
      plan.baseHead,
    );
    let finalApproved = Object.values(state.commands).some(
      (x) => (x as { finalApproval?: boolean })?.finalApproval,
    );
    lastClock = Date.now();
    clockActive = true;
    const processCommands = async () => {
      for (const cmd of await pendingCommands(store)) {
        if (cmd.expectedRevision !== plan.graph.revision) {
          await store.append(
            {
              type: "command.applied",
              payload: {
                commandId: cmd.commandId,
                result: { error: "revision_conflict" },
              },
            },
            plan.graph.revision,
          );
          continue;
        }
        if (cmd.type === "approve_final") finalApproved = true;
        if (cmd.type === "cancel") cancelled = true;
        await store.append(
          {
            type: "command.applied",
            payload: {
              commandId: cmd.commandId,
              result: {
                accepted: true,
                ...(cmd.type === "approve_final"
                  ? { finalApproval: true }
                  : {}),
                ...(cmd.note ? { note: redact(cmd.note) } : {}),
              },
            },
          },
          plan.graph.revision,
        );
        if (cmd.type === "stop" || cmd.type === "cancel") stop();
      }
      const now = Date.now();
      await store.append(
        { type: "runtime.elapsed", payload: { ms: now - lastClock } },
        plan.graph.revision,
      );
      budget.activeMs += now - lastClock;
      lastClock = now;
    };
    await processCommands();
    timer = setInterval(() => {
      commandLoop = commandLoop
        .then(processCommands)
        .catch((e) => controller.abort(e));
    }, 1000);
    await store.append(
      { type: "run.status", payload: { status: "running" } },
      plan.graph.revision,
    );
    if (options.resume) {
      state = await store.state();
      for (const n of plan.graph.nodes) {
        const s = state.nodes[n.nodeId];
        if (s && ["running", "verifying", "retry_wait"].includes(s.status))
          await store.append(
            {
              type: "node.status",
              payload: {
                nodeId: n.nodeId,
                generation: n.generation,
                status: "interrupted",
              },
            },
            plan.graph.revision,
          );
        if (
          s &&
          !["completed", "cancelled", "pending", "queued"].includes(s.status)
        )
          await store.append(
            {
              type: "node.status",
              payload: {
                nodeId: n.nodeId,
                generation: n.generation,
                status: "pending",
              },
            },
            plan.graph.revision,
          );
      }
    }
    const dependencies = async (node: NodeSpec): Promise<NodeResult[]> => {
      const current = await store.state();
      return topological(plan.graph)
        .filter((id) => artifactAncestors(plan.graph, node.nodeId).has(id))
        .map((id) => current.nodes[id]?.result)
        .filter((r): r is NodeResult =>
          Boolean(
            r?.outcome === "completed" &&
            ["worker", "read"].includes(
              plan.graph.nodes.find((n) => n.nodeId === r.nodeId)?.kind ?? "",
            ),
          ),
        );
    };
    const execute = async (node: NodeSpec): Promise<NodeResult> => {
      if (node.kind === "worker") {
        const source =
          node.nodeId === "repair" && plan.graph.reason === "repair"
            ? (await store.readAfter()).findLast(
                (e) =>
                  e.graphRevision === plan.graph.parentRevision &&
                  e.type === "node.status" &&
                  e.payload.status === "failed" &&
                  ["integrate", "validate"].includes(
                    plan.graph.nodes.find((n) => n.nodeId === e.payload.nodeId)
                      ?.kind ?? "",
                  ),
              )
            : undefined;
        return runRalphLoop({
          inputBase:
            source?.type === "node.status"
              ? source.payload.result?.outputHead
              : undefined,
          repairEvidence:
            source?.type === "node.status"
              ? await Promise.all(
                  (source.payload.result?.evidenceIds ?? []).map((id) =>
                    store.artifact(id),
                  ),
                )
              : undefined,
          plan,
          node,
          store,
          gateway,
          manager,
          dependencies: await dependencies(node),
          signal,
          verificationLimits,
        });
      }
      if (node.kind === "read") {
        const r = routesFor(plan.config, plan.contract, "contractPlanner");
        const outcome = await gateway.invoke(
          r.routes,
          {
            runId: plan.runId,
            nodeId: node.nodeId,
            role: "contractPlanner",
            projectRoot: plan.projectRoot,
            prompt: `Read-only response. Do not modify files. ${plan.context.request}\nContext: ${JSON.stringify(plan.context.sources)}`,
          },
          signal,
          undefined,
          r.hardPin,
        );
        const artifactId = await store.putArtifact({
          summary: redact(outcome.result.text),
        });
        return {
          nodeId: node.nodeId,
          generation: node.generation,
          inputDigest: digest(plan.context),
          outcome: "completed",
          artifactIds: [artifactId],
          evidenceIds: [],
          summary: redact(outcome.result.text),
        };
      }
      if (node.kind === "integrate") {
        let input;
        try {
          const repair =
            plan.graph.reason === "repair"
              ? (await store.state()).nodes.repair?.result
              : undefined;
          input = await manager.prepare(
            node.nodeId,
            node.generation,
            repair?.outputHead ? [] : await dependencies(node),
            { baseHead: repair?.outputHead, retainConflicts: true },
          );
        } catch (e) {
          if (!(e instanceof IntegrationConflict)) throw e;
          const artifactId = await store.putArtifact({
            summary: "Resolve conflicts against the complete approved contract",
            errors: e.input.conflictErrors,
          });
          return {
            nodeId: node.nodeId,
            generation: node.generation,
            inputDigest: e.input.inputDigest,
            inputHead: plan.baseHead,
            outputHead: e.input.inputHead,
            workspace: e.input.root,
            outcome: "failed",
            artifactIds: [artifactId],
            evidenceIds: [artifactId],
            summary:
              "Git conflicts retained in the integration snapshot; repair required",
          };
        }
        return {
          nodeId: node.nodeId,
          generation: node.generation,
          inputDigest: input.inputDigest,
          inputHead: plan.baseHead,
          outputHead: input.inputHead,
          workspace: input.root,
          outcome: "completed",
          artifactIds: [],
          evidenceIds: [],
          summary: "Dependency artifacts integrated",
        };
      }
      const current = await store.state();
      const parent = plan.graph.edges
        .filter((e) => e.to === node.nodeId)
        .map((e) => current.nodes[e.from]?.result)
        .find((r) => r?.workspace);
      if (!parent?.workspace)
        throw new RalphError(
          "Final validation requires integrated input",
          "invalid_graph",
          4,
        );
      const result = await runVerifier(
        parent.workspace,
        plan.config,
        plan.envelope.verifierIds,
        plan.contract.requiredArtifacts,
        {
          riskTier: classifyRisk(plan.contract),
          contract: plan.contract,
          signal,
          baseHead: plan.baseHead,
        },
      );
      const diff = await git(parent.workspace, [
        "diff",
        plan.baseHead,
        "HEAD",
        "--",
      ]);
      const r = routesFor(plan.config, plan.contract, "critic");
      const review = await gateway.invoke(
        r.routes,
        {
          runId: plan.runId,
          nodeId: node.nodeId,
          role: "critic",
          projectRoot: parent.workspace,
          prompt: await criticPrompt(plan.contract, "post", {
            head: await gitHead(parent.workspace),
            status: await gitStatus(parent.workspace),
            diff,
            verifier: result.summary,
          }),
        },
        signal,
        (text) => {
          if (!validateAssessment(parseJsonObject(text)))
            throw new Error("Invalid final assessment");
        },
        r.hardPin,
      );
      const assessment = parseJsonObject(review.result.text);
      if (!validateAssessment(assessment))
        throw new Error("Invalid assessment");
      const evaluation = await evaluateAssessment(
        plan.contract.taskType,
        assessment,
        { workerOk: true, verifierOk: result.ok },
      );
      const artifactId = await store.putArtifact({
        verifier: result,
        assessment,
        evaluation,
        diff,
      });
      await store.append(
        {
          type: "evidence.saved",
          payload: {
            nodeId: node.nodeId,
            artifactId,
            summary: evaluation.reason,
          },
        },
        plan.graph.revision,
      );
      return {
        ...parent,
        nodeId: node.nodeId,
        generation: node.generation,
        outcome:
          result.ok && evaluation.verdict === "pass" ? "completed" : "failed",
        artifactIds: [artifactId],
        evidenceIds: [artifactId],
        summary: evaluation.reason,
      };
    };
    for (
      let repairs = events.filter(
        (e) =>
          e.type === "graph.revised" && e.payload.graph.reason === "repair",
      ).length;
      ;
      repairs++
    ) {
      state = await schedule(
        plan.graph,
        store,
        plan.budget.concurrency,
        execute,
        signal,
      );
      if (signal.aborted) {
        await store.append(
          {
            type: "run.status",
            payload: {
              status: cancelled ? "cancelled" : "paused",
              message: String(signal.reason),
            },
          },
          plan.graph.revision,
        );
        break;
      }
      const failed = plan.graph.nodes.find(
        (n) =>
          ["integrate", "validate"].includes(n.kind) &&
          state.nodes[n.nodeId]?.status === "failed",
      );
      const workersDone = plan.graph.nodes
        .filter((n) => n.kind === "worker")
        .every((n) => state.nodes[n.nodeId]?.status === "completed");
      if (failed && workersDone && repairs < plan.budget.maxRepairs) {
        const workers = plan.graph.nodes.filter((n) => n.kind === "worker");
        const repair: NodeSpec = {
          ...workers[0]!,
          nodeId: "repair",
          generation: state.nodes.repair?.generation ?? 0,
          goal: `Repair final integration: ${state.nodes[failed.nodeId]?.result?.summary}`,
          readPaths: plan.envelope.readPaths,
          writePaths: plan.envelope.writePaths,
          acceptanceCriteria: plan.contract.acceptanceCriteria,
          verifierIds: plan.envelope.verifierIds,
        };
        const original = workers.filter((n) => n.nodeId !== "repair");
        const integration = {
          ...plan.graph.nodes.find((n) => n.kind === "integrate")!,
        };
        const validation = {
          ...plan.graph.nodes.find((n) => n.kind === "validate")!,
        };
        const proposal = {
          ...plan.graph,
          reason: "repair" as const,
          nodes: [...original, repair, integration, validation],
          edges: [
            ...plan.graph.edges.filter(
              (e) =>
                original.some((n) => n.nodeId === e.from) &&
                original.some((n) => n.nodeId === e.to),
            ),
            ...original.map((n) => ({
              from: n.nodeId,
              to: "repair",
              kind: "artifact" as const,
            })),
            {
              from: "repair",
              to: integration.nodeId,
              kind: "artifact" as const,
            },
            {
              from: integration.nodeId,
              to: validation.nodeId,
              kind: "artifact" as const,
            },
          ],
        };
        plan.graph = reviseGraph(
          plan.graph,
          proposal,
          state.nodes,
          plan.envelope,
        );
        const generations = new Set(
          (await store.readAfter()).flatMap((e) =>
            e.type === "graph.revised"
              ? e.payload.graph.nodes.map((n) => `${n.nodeId}/${n.generation}`)
              : [],
          ),
        );
        for (const n of plan.graph.nodes)
          generations.add(`${n.nodeId}/${n.generation}`);
        if (generations.size > plan.budget.maxTotalNodes)
          throw new RalphError(
            "Total node budget exhausted",
            "budget_exhausted",
            10,
          );
        await store.append(
          { type: "graph.revised", payload: { graph: plan.graph } },
          plan.graph.revision,
        );
        continue;
      }
      if (Object.values(state.nodes).some((n) => n.status !== "completed")) {
        await store.append(
          {
            type: "run.status",
            payload: {
              status: "awaiting_input",
              message:
                "One or more required nodes are blocked; inspect node evidence",
            },
          },
          plan.graph.revision,
        );
        break;
      }
      if (plan.mode !== "answer") {
        if (classifyRisk(plan.contract) === "T3" && !finalApproved) {
          await store.append(
            {
              type: "run.status",
              payload: {
                status: "awaiting_input",
                message: "T3 final confirmation required",
              },
            },
            plan.graph.revision,
          );
          break;
        }
        const final = plan.graph.nodes.find((n) => n.kind === "validate")!;
        const workspace = state.nodes[final.nodeId]!.result!.workspace!;
        const head = await deliverResult(
          plan.projectRoot,
          workspace,
          plan.baseHead,
          plan.baseBranch,
          plan.runId,
          join(store.directory, "integration", "delivery.json"),
        );
        await store.append(
          {
            type: "run.status",
            payload: { status: "completed", resultHead: head },
          },
          plan.graph.revision,
        );
      } else
        await store.append(
          { type: "run.status", payload: { status: "completed" } },
          plan.graph.revision,
        );
      break;
    }
  } catch (e) {
    await store.append(
      {
        type: "run.status",
        payload: {
          status:
            e instanceof RalphError && e.exitCode === 10
              ? "awaiting_input"
              : "failed",
          message: redact(String(e)),
        },
      },
      plan.graph.revision,
    );
  } finally {
    if (timer) clearInterval(timer);
    await commandLoop;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    try {
      if (clockActive)
        await store.append(
          { type: "runtime.elapsed", payload: { ms: Date.now() - lastClock } },
          plan.graph.revision,
        );
      await store.saveSnapshot();
    } finally {
      await store.release();
    }
  }
  return store.state();
}
export async function resumeGraphRun(
  projectRoot: string,
  runId: string,
  signal?: AbortSignal,
): Promise<GraphRunState> {
  const store = await storeFor(projectRoot, runId);
  const plan = JSON.parse(
    await readFile(join(store.directory, "plan.json"), "utf8"),
  ) as ExecutionPlan;
  return startRun(plan, { resume: true, signal });
}
export async function* watchRun(
  projectRoot: string,
  runId: string,
  after = 0,
  signal?: AbortSignal,
) {
  const store = await storeFor(projectRoot, runId);
  while (!signal?.aborted) {
    for (const event of await store.readAfter(after)) {
      after = event.seq;
      yield event;
    }
    const state = await store.state();
    if (
      ["completed", "failed", "cancelled", "paused", "awaiting_input"].includes(
        state.status,
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

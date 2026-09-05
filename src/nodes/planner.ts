import { collectRoutingHistory } from "../gateway/history.js";
import { roleRoutes, classifyRisk } from "../policy.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { collectContext } from "../context/snapshot.js";
import { gitBranch } from "../git.js";
import { loadConfig, statePaths } from "../state.js";
import { ProviderGateway } from "../gateway/gateway.js";
import { routesFor } from "../gateway/routing.js";
import { BudgetCounter } from "../runtime/budget.js";
import {
  DEFAULT_BUDGET,
  GraphSchema,
  type GraphRevision,
} from "../graph/schema.js";
import {
  singleGraph,
  compileGraph,
  type GraphEnvelope,
} from "../graph/compiler.js";
import { validateContract, validateContractDraft } from "../contracts.js";
import { contractPlannerPrompt, contractCriticPrompt } from "../prompts.js";
import { parseJsonObject, RalphError } from "../util.js";
import { RunStore } from "../storage/run-store.js";
import { durableWrite } from "../storage/journal.js";
import type { ExecutionPlan } from "../interaction/approval.js";
import type { TaskContract, ProjectConfig } from "../types.js";

export async function draftTask(
  projectRoot: string,
  request: string,
  config: ProjectConfig,
  gateway: ProviderGateway,
  runId: string,
  signal: AbortSignal,
): Promise<TaskContract> {
  let contract: TaskContract | undefined;
  let feedback = "";
  for (let i = 0; i < 3; i++) {
    const routes = roleRoutes(config, "contractPlanner").filter((r) => {
      const pin = config.routePolicies?.contractPlanner?.hardPin;
      return (
        !pin ||
        (r.connectionId === pin.connectionId && r.modelId === pin.modelId)
      );
    });
    const outcome = await gateway.invoke(
      routes,
      {
        runId,
        nodeId: "contract-planner",
        role: "contractPlanner",
        projectRoot,
        prompt: contractPlannerPrompt(request, projectRoot) + feedback,
      },
      signal,
      (text) => validateContractDraft(parseJsonObject(text), projectRoot),
      Boolean(config.routePolicies?.contractPlanner?.hardPin),
    );
    contract = validateContractDraft(
      parseJsonObject(outcome.result.text),
      projectRoot,
    );
    const r = routesFor(config, contract, "critic");
    const alternatives = r.routes.filter(
      (x) => x.provider !== outcome.route.provider,
    );
    const review = await gateway.invoke(
      alternatives.length && !r.hardPin ? alternatives : r.routes,
      {
        runId,
        nodeId: "contract-critic",
        role: "critic",
        projectRoot,
        prompt: contractCriticPrompt(contract),
      },
      signal,
      (text) => {
        const p = parseJsonObject<{ status: string; issues: string[] }>(text);
        if (!["pass", "revise"].includes(p.status) || !Array.isArray(p.issues))
          throw new Error("Invalid contract review");
      },
      r.hardPin,
    );
    const assessment = parseJsonObject<{ status: string; issues: string[] }>(
      review.result.text,
    );
    if (assessment.status === "pass")
      return { ...contract, riskTier: classifyRisk(contract) };
    feedback = `\nCorrect these contract defects: ${JSON.stringify(assessment.issues)}`;
  }
  throw new RalphError(
    "Contract needs clarification after three reviews",
    "input_required",
    10,
  );
}
export async function planRun(
  projectRoot: string,
  request: string,
  options: {
    contract?: TaskContract;
    graph?: GraphRevision;
    mode?: "answer" | "single" | "graph";
    host?: { summary: string };
    runId?: string;
    config?: ProjectConfig;
    originRunId?: string;
  } = {},
): Promise<ExecutionPlan> {
  const runId = options.runId ?? `run-${randomUUID()}`;
  const root = (await statePaths(projectRoot)).root;
  const store = new RunStore(root, runId);
  await store.acquire();
  const planningStarted = Date.now();
  try {
    const initial = await store.state();
    if (Object.values(initial.nodes).some((n) => n.startedAt))
      throw new RalphError(
        "This execution has started; use a repair revision or create a new run",
        "revision_conflict",
        10,
      );
    const context = await collectContext(projectRoot, request, options.host);
    await durableWrite(
      join(store.directory, "context.json"),
      JSON.stringify(context),
    );
    const config = structuredClone(
      options.config ?? (await loadConfig(projectRoot)),
    );
    config.operationalMeasurements = await collectRoutingHistory(projectRoot);
    const budget = { ...DEFAULT_BUDGET };
    const state = await store.state();
    const gateway = new ProviderGateway(
      config,
      new BudgetCounter(budget, state.attempts, state.activeMs),
      (event) => store.append(event, 1),
    );
    const signal = AbortSignal.timeout(
      Math.max(1, budget.activeMs - state.activeMs),
    );
    const answerMode =
      options.mode === "answer" ||
      (!options.mode &&
        /^(explain|what|why|how|설명|무엇|왜)\b/i.test(request.trim()));
    const contract =
      options.contract ??
      (answerMode
        ? validateContract(
            {
              taskType: "planning_architecture",
              goal: request,
              include: [],
              exclude: [],
              acceptanceCriteria: ["Provide an evidence-based answer"],
              executionProfile: "balanced",
            },
            projectRoot,
          )
        : await draftTask(
            projectRoot,
            `${request}\nContext (reference data): ${JSON.stringify(context.sources)}`,
            config,
            gateway,
            runId,
            signal,
          ));
    const envelope: GraphEnvelope = {
      readPaths: ["**"],
      writePaths: contract.include,
      exclude: contract.exclude,
      verifierIds: contract.verifierCommands.length
        ? contract.verifierCommands
        : config.verifierCommands,
      budget,
    };
    const task = {
      taskType: contract.taskType,
      goal: contract.goal,
      readPaths: ["**"],
      writePaths: contract.include,
      acceptanceCriteria: contract.acceptanceCriteria,
      requiredCapabilities: [],
      inputArtifacts: [],
      verifierIds: envelope.verifierIds,
      budget: { maxIterations: 6 },
    };
    let graph = options.graph
      ? { ...options.graph, runId }
      : singleGraph(runId, task);
    const mode = answerMode ? "answer" : (options.mode ?? "graph");
    if (mode === "answer") {
      graph = {
        schemaVersion: 1,
        runId,
        revision: 1,
        reason: "initial",
        nodes: [
          {
            ...task,
            nodeId: "answer",
            generation: 0,
            kind: "read",
            writePaths: [],
            verifierIds: [],
          },
        ],
        edges: [],
      };
    } else if (!options.graph && mode !== "single") {
      let feedback = "";
      for (let i = 0; i < 3; i++) {
        try {
          const r = routesFor(config, contract, "contractPlanner");
          const answer = await gateway.invoke(
            r.routes,
            {
              runId,
              nodeId: "graph-planner",
              role: "contractPlanner",
              projectRoot,
              prompt: `Decompose the approved-scope contract into a DAG. Use only necessary workers, one integrate node and one final validate node. Every worker must reach integration and final validation. Return JSON matching ${JSON.stringify(GraphSchema)}. Use runId ${runId}. Contract: ${JSON.stringify(contract)}. Allowed verifiers: ${JSON.stringify(envelope.verifierIds)}. ${feedback}`,
            },
            signal,
          );
          graph = compileGraph(
            { ...parseJsonObject<GraphRevision>(answer.result.text), runId },
            envelope,
          );
          break;
        } catch (e) {
          if (
            e instanceof RalphError &&
            ["authentication", "policy_denial", "budget_exhausted"].includes(
              e.code,
            )
          )
            throw e;
          feedback = String(e);
          graph = singleGraph(runId, task);
        }
      }
    }
    graph = compileGraph(graph, envelope);
    if (Object.keys(state.nodes).length) {
      graph = {
        ...graph,
        revision: state.revision + 1,
        parentRevision: state.revision,
        reason: "expansion",
      };
    }
    for (const node of graph.nodes.filter((n) => n.kind === "worker"))
      routesFor(config, { ...contract, taskType: node.taskType }, "worker");
    const plan: ExecutionPlan = {
      schemaVersion: 2,
      ...(options.originRunId ? { originRunId: options.originRunId } : {}),
      runId,
      mode:
        mode === "answer"
          ? "answer"
          : graph.nodes.filter((n) => n.kind === "worker").length === 1
            ? "single"
            : "graph",
      projectRoot,
      baseHead: context.baseHead,
      baseBranch: await gitBranch(projectRoot),
      context,
      contract,
      config,
      graph,
      envelope,
      budget,
    };
    await durableWrite(
      join(store.directory, "plan.json"),
      JSON.stringify(plan),
    );
    await durableWrite(
      join(store.directory, "context.json"),
      JSON.stringify(context),
    );
    await store.append(
      { type: "graph.revised", payload: { graph } },
      graph.revision,
    );
    await store.append(
      {
        type: "run.status",
        payload: {
          status: "awaiting_input",
          message: "Review the execution plan before approval",
        },
      },
      1,
    );
    await store.saveSnapshot();
    return plan;
  } catch (error) {
    if (Object.values((await store.state()).nodes).some((n) => n.startedAt))
      throw error;
    const question = {
      id: randomUUID(),
      runId,
      reason: "ambiguous_goal",
      questions: [
        {
          id: "clarify",
          prompt:
            "Specify the target files, expected behavior, and completion checks. " +
            String(error),
          required: true,
        },
      ],
      blocksExecution: true,
    };
    await durableWrite(
      join(store.directory, "question.json"),
      JSON.stringify(question),
    );
    await store.append({ type: "question.created", payload: { question } }, 1);
    await store.append(
      {
        type: "run.status",
        payload: { status: "awaiting_input", message: String(error) },
      },
      1,
    );
    throw Object.assign(
      error instanceof Error ? error : new Error(String(error)),
      { runId, question },
    );
  } finally {
    try {
      await store.append(
        {
          type: "runtime.elapsed",
          payload: { ms: Date.now() - planningStarted },
        },
        (await store.state()).revision,
      );
    } finally {
      await store.release();
    }
  }
}

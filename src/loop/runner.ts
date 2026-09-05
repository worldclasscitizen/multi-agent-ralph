import { saveLoopCheckpoint, loadLoopCheckpoint } from "./state.js";
import { ConnectionLimits } from "../gateway/limits.js";
import { git } from "../workspace/manager.js";
import { gitHead, gitStatus } from "../git.js";
import { matches, covered } from "../graph/compiler.js";
import { digest, type NodeSpec, type NodeResult } from "../graph/schema.js";
import type { ExecutionPlan } from "../interaction/approval.js";
import type { ProviderGateway } from "../gateway/gateway.js";
import { routesFor } from "../gateway/routing.js";
import type { RunStore } from "../storage/run-store.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { runVerifier } from "../verifier.js";
import { criticPrompt, workerPrompt, metaPrompt } from "../prompts.js";
import {
  evaluateAssessment,
  validateAssessment,
  needsBoundaryAdjudication,
} from "../evaluator.js";
import { classifyRisk } from "../policy.js";
import { parseJsonObject, RalphError, redact } from "../util.js";
import type { CriticAssessment } from "../types.js";

export async function checkScope(
  root: string,
  inputHead: string,
  node: NodeSpec,
  exclude: string[],
): Promise<void> {
  const changed = await git(root, [
    "diff",
    "--name-only",
    "-z",
    inputHead,
    "--",
  ]);
  const untracked = await git(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  for (const path of new Set(
    (changed + "\0" + untracked).split("\0").filter(Boolean),
  ))
    if (
      !covered(path, node.writePaths) ||
      exclude.some((p) => matches(path, p))
    )
      throw new RalphError(
        `Node wrote outside its scope: ${path}`,
        "scope_violation",
        10,
      );
}
export async function runRalphLoop(context: {
  plan: ExecutionPlan;
  node: NodeSpec;
  store: RunStore;
  gateway: ProviderGateway;
  manager: WorkspaceManager;
  dependencies: NodeResult[];
  signal: AbortSignal;
  verificationLimits?: ConnectionLimits;
  inputBase?: string;
  repairEvidence?: unknown;
}): Promise<NodeResult> {
  const { plan, node, store, gateway, manager, signal } = context;
  const input = await manager.prepare(
    node.nodeId,
    node.generation,
    context.inputBase ? [] : context.dependencies,
    { baseHead: context.inputBase },
  );
  const contract = {
    ...plan.contract,
    projectRoot: input.root,
    taskType: node.taskType,
    goal: node.goal,
    include: node.writePaths,
    acceptanceCriteria: node.acceptanceCriteria,
    verifierCommands: node.verifierIds,
    requiredArtifacts: plan.contract.requiredArtifacts.filter((p) =>
      covered(p, node.writePaths),
    ),
  };
  const old = await store.state();
  const saved = await loadLoopCheckpoint(store, node, input.inputDigest);
  if (saved?.result.outcome === "completed" && saved.result.outputHead)
    return saved.result;
  let previousFingerprint = saved?.fingerprint ?? "",
    previousScore = saved?.score ?? -1,
    stagnation = saved?.stagnation ?? 0;
  let memory =
    saved?.memory ??
    JSON.stringify({
      dependencies: context.dependencies.map((r) => ({
        nodeId: r.nodeId,
        summary: r.summary,
        evidenceIds: r.evidenceIds,
      })),
      repairEvidence: context.repairEvidence,
    });
  let lastResult: NodeResult | undefined = saved?.result;
  for (
    let iteration = (old.nodes[node.nodeId]?.iteration ?? 0) + 1;
    iteration <= node.budget.maxIterations;
    iteration++
  ) {
    signal.throwIfAborted();
    await store.append(
      {
        type: "node.status",
        payload: {
          nodeId: node.nodeId,
          generation: node.generation,
          status: "running",
          iteration,
        },
      },
      plan.graph.revision,
    );
    const routing = routesFor(plan.config, contract, "worker");
    await store.append(
      {
        type: "route.selected",
        payload: {
          nodeId: node.nodeId,
          connectionId: routing.routes[0]!.connectionId,
          modelId: routing.routes[0]!.modelId,
          reason: routing.hardPin
            ? "Explicit model pin"
            : "Approved quality-first candidate portfolio",
        },
      },
      plan.graph.revision,
    );
    const outcome = await gateway.invoke(
      routing.routes,
      {
        runId: plan.runId,
        generation: node.generation,
        iteration,
        nodeId: node.nodeId,
        role: "worker",
        projectRoot: input.root,
        prompt: workerPrompt(
          contract,
          `Task-specific acceptance: ${JSON.stringify(node.acceptanceCriteria)}\nPrevious verified observations:\n${memory}`,
          await gitHead(input.root),
        ),
        compactPrompt: workerPrompt(
          contract,
          `Preserve every contract requirement. Detailed earlier logs are omitted after context overflow. Inspect the current workspace before acting. Input digest: ${input.inputDigest}. Prior evidence IDs: ${(lastResult?.evidenceIds ?? context.dependencies.flatMap((d) => d.evidenceIds)).join(", ")}.`,
          await gitHead(input.root),
        ),
        writePaths: node.writePaths,
        excludePaths: contract.exclude,
        readPaths: node.readPaths,
      },
      signal,
      undefined,
      routing.hardPin,
    );
    await checkScope(input.root, input.inputHead, node, plan.contract.exclude);
    await store.append(
      {
        type: "node.status",
        payload: {
          nodeId: node.nodeId,
          generation: node.generation,
          status: "verifying",
          iteration,
        },
      },
      plan.graph.revision,
    );
    const verifier = await (
      context.verificationLimits ?? new ConnectionLimits(1)
    ).use("verification", signal, () =>
      runVerifier(
        input.root,
        plan.config,
        node.verifierIds,
        contract.requiredArtifacts,
        {
          riskTier: classifyRisk(contract),
          contract,
          signal,
          baseHead: input.inputHead,
        },
      ),
    );
    await checkScope(input.root, input.inputHead, node, plan.contract.exclude);
    await git(input.root, ["add", "-A", "--", "."]);
    const diff = await git(input.root, [
      "diff",
      "--binary",
      input.inputHead,
      "--",
    ]);
    const verifiedTree = await git(input.root, ["write-tree"]);
    const critic = routesFor(plan.config, contract, "critic");
    const independent = critic.routes.filter(
      (r) => r.provider !== outcome.route.provider,
    );
    const review = await gateway.invoke(
      independent.length && !critic.hardPin ? independent : critic.routes,
      {
        runId: plan.runId,
        generation: node.generation,
        iteration,
        nodeId: node.nodeId,
        role: "critic",
        projectRoot: input.root,
        prompt: await criticPrompt(contract, "post", {
          head: await gitHead(input.root),
          status: await gitStatus(input.root),
          diff,
          verifier: verifier.summary,
        }),
      },
      signal,
      (text) => parseAssessment(text),
      critic.hardPin,
    );
    let assessment = parseAssessment(review.result.text);
    let evaluation = await evaluateAssessment(contract.taskType, assessment, {
      workerOk: true,
      verifierOk: verifier.ok,
    });
    if (needsBoundaryAdjudication(evaluation)) {
      const r = routesFor(plan.config, contract, "adjudicator");
      const answer = await gateway.invoke(
        r.routes,
        {
          runId: plan.runId,
          generation: node.generation,
          iteration,
          nodeId: node.nodeId,
          role: "adjudicator",
          projectRoot: input.root,
          prompt: await criticPrompt(contract, "adjudication", {
            head: await gitHead(input.root),
            status: await gitStatus(input.root),
            diff,
            verifier: verifier.summary,
          }),
        },
        signal,
        (text) => parseAssessment(text),
        r.hardPin,
      );
      assessment = parseAssessment(answer.result.text);
      evaluation = await evaluateAssessment(contract.taskType, assessment, {
        workerOk: true,
        verifierOk: verifier.ok,
      });
    }
    await git(input.root, ["add", "-A", "--", "."]);
    if ((await git(input.root, ["write-tree"])) !== verifiedTree)
      throw new RalphError(
        "Files changed during independent evaluation",
        "input_changed",
        10,
      );
    const fingerprint = digest({
      commands: verifier.commands.map((c) => ({
        command: c.command,
        exitCode: c.exitCode,
      })),
      gates: verifier.gates,
      findings: assessment.findings,
    });
    const evidence = {
      schemaVersion: 2,
      nodeId: node.nodeId,
      generation: node.generation,
      iteration,
      inputDigest: input.inputDigest,
      inputHead: input.inputHead,
      summary: redact(outcome.result.text),
      verifier,
      assessment,
      evaluation,
      failureFingerprint: fingerprint,
      independence: independent.length ? "different_provider" : "same_provider",
      diff,
    };
    const evidenceId = await store.putArtifact(evidence);
    await store.append(
      {
        type: "evidence.saved",
        payload: {
          nodeId: node.nodeId,
          artifactId: evidenceId,
          summary: `Iteration ${iteration}: score ${evaluation.score}, verifier ${verifier.ok ? "pass" : "fail"}`,
        },
      },
      plan.graph.revision,
    );
    lastResult = {
      nodeId: node.nodeId,
      generation: node.generation,
      inputDigest: input.inputDigest,
      inputHead: input.inputHead,
      workspace: input.root,
      outcome:
        verifier.ok && evaluation.verdict === "pass" ? "completed" : "blocked",
      artifactIds: [evidenceId],
      evidenceIds: [evidenceId],
      summary: evaluation.reason,
    };
    stagnation = evaluation.score - previousScore < 3 ? stagnation + 1 : 0;
    memory = JSON.stringify({
      verifier: verifier.summary,
      findings: assessment.findings,
      unresolved: assessment.criteria.filter((c) =>
        ["absent", "partial"].includes(c.level),
      ),
    });
    const checkpoint = {
      tree: verifiedTree,
      nodeDigest: digest(node),
      iteration,
      fingerprint,
      score: evaluation.score,
      stagnation,
      memory,
      result: lastResult,
    };
    await saveLoopCheckpoint(store, node, checkpoint);
    lastResult.outputHead = await manager.checkpoint(
      input.root,
      node.nodeId,
      node.generation,
      iteration,
    );
    await saveLoopCheckpoint(store, node, checkpoint);
    if (
      lastResult.outcome === "completed" ||
      fingerprint === previousFingerprint ||
      evaluation.verdict === "needs_operator" ||
      stagnation >= 2
    )
      return lastResult;
    previousFingerprint = fingerprint;
    previousScore = evaluation.score;
  }
  return (
    lastResult ?? {
      nodeId: node.nodeId,
      generation: node.generation,
      inputDigest: input.inputDigest,
      outcome: "blocked",
      artifactIds: [],
      evidenceIds: [],
      summary: "Logical node iteration budget exhausted",
    }
  );
}

function parseAssessment(text: string): CriticAssessment {
  const value = parseJsonObject(text);
  if (!validateAssessment(value)) throw new Error("Invalid critic assessment");
  return value;
}

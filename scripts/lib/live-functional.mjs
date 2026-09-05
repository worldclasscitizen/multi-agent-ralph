import assert from "node:assert/strict";
import { resolve } from "node:path";
import { task } from "../live-fixture.mjs";
import { git } from "../../dist/workspace/manager.js";

export const functionalRequest = `${task.goal} Decompose the two independent files into two workers, one for each module, followed by integration and final validation. Frozen public tests already exist: left.test.mjs and right.test.mjs. Read them but never modify them. Use exactly these approved verifier commands across the contract: ${JSON.stringify(task.verifierCommands)}. A worker runs only its own module's behavior and syntax checks plus git diff --check; final validation runs all five commands. Both modules are required artifacts. Preserve these requirements in the task contract. No external actions or additional permissions are authorized.`;
const sorted = values => [...values].sort();
export function assertFunctionalPlan(plan) {
  assert.equal(plan.mode, "graph", "Expected a generated multi-worker graph");
  assert.deepEqual(sorted(plan.contract.include), sorted(task.include), "Contract write scope changed");
  assert.deepEqual(sorted(plan.envelope.verifierIds), sorted(task.verifierCommands), "Contract validation changed");
  assert.deepEqual(sorted(plan.contract.requiredArtifacts), sorted(task.requiredArtifacts));
  const workers = plan.graph.nodes.filter(n => n.kind === "worker");
  assert.equal(workers.length, 2);
  assert.equal(plan.graph.nodes.length, 4, "Expected two workers, integration and validation");
  const integration = plan.graph.nodes.filter(n => n.kind === "integrate"), validation = plan.graph.nodes.filter(n => n.kind === "validate");
  assert.equal(integration.length, 1); assert.equal(validation.length, 1);
  for (const file of task.include) {
    const worker = workers.find(n => n.writePaths.length === 1 && n.writePaths[0] === file);
    assert.ok(worker, `Missing scoped worker for ${file}`);
    assert.deepEqual(sorted(worker.verifierIds), sorted([`node --test ${file.replace(".mjs", ".test.mjs")}`, `node --check ${file}`, "git diff --check"]));
    assert.ok(plan.graph.edges.some(e => e.from === worker.nodeId && e.to === integration[0].nodeId && e.kind === "artifact"));
    assert.ok(!plan.graph.edges.some(e => e.to === worker.nodeId), "Independent workers must not depend on each other");
  }
  assert.ok(plan.graph.edges.some(e => e.from === integration[0].nodeId && e.to === validation[0].nodeId));
  assert.deepEqual(sorted(validation[0].verifierIds), sorted(task.verifierCommands));
  return workers;
}
export async function inspectFunctionalResult(root, plan, state, store) {
  const workers = assertFunctionalPlan(plan);
  assert.equal(state.status, "completed", "Runtime did not complete");
  assert.ok(state.resultHead);
  assert.equal(await git(root, ["symbolic-ref", "--short", "HEAD"]), plan.baseBranch);
  assert.equal(await git(root, ["rev-parse", "HEAD"]), state.resultHead);
  assert.equal(await git(root, ["status", "--porcelain"]), "");
  assert.deepEqual(sorted((await git(root, ["diff", "--name-only", plan.baseHead, "HEAD"])).split(/\r?\n/).filter(Boolean)), sorted(task.include));
  const summaries = [];
  for (const node of plan.graph.nodes) {
    const result = state.nodes[node.nodeId]?.result;
    assert.equal(state.nodes[node.nodeId]?.status, "completed");
    assert.equal(result?.outcome, "completed");
    if (node.kind === "worker") {
      assert.ok(result.workspace && resolve(result.workspace) !== resolve(root));
      assert.deepEqual((await git(result.workspace, ["diff", "--name-only", result.inputHead, result.outputHead])).split(/\r?\n/).filter(Boolean), node.writePaths);
    }
    if (node.kind !== "integrate") {
      assert.ok(result.evidenceIds.length > 0);
      for (const id of result.evidenceIds) {
        const evidence = await store.artifact(id);
        assert.equal(evidence.verifier.ok, true);
        assert.equal(evidence.evaluation.verdict, "pass");
        assert.ok(evidence.assessment);
      }
    }
    summaries.push({ nodeId: node.nodeId, kind: node.kind, iteration: state.nodes[node.nodeId].iteration, inputHead: result.inputHead, outputHead: result.outputHead, evidenceIds: result.evidenceIds });
  }
  assert.equal(new Set(workers.map(n => resolve(state.nodes[n.nodeId].result.workspace))).size, 2);
  const events = await store.readAfter(0);
  const calls = events.filter(e => e.type === "invocation.started").map(e => ({ nodeId: e.payload.nodeId, role: e.payload.role }));
  for (const id of ["contract-planner", "contract-critic", "graph-planner"]) assert.ok(calls.some(c => c.nodeId === id), `Missing actual planning invocation: ${id}`);
  const integrated = plan.graph.nodes.find(n => n.kind === "integrate");
  const integrationStart = events.find(e => e.type === "node.status" && e.payload.nodeId === integrated.nodeId && e.payload.status === "running");
  for (const worker of workers) assert.ok(events.some(e => e.seq < integrationStart.seq && e.type === "node.status" && e.payload.nodeId === worker.nodeId && e.payload.status === "completed"));
  return { workerCount: workers.length, nodes: summaries, invocationRoles: calls, eventCount: events.length };
}

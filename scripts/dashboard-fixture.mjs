import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git } from "../dist/workspace/manager.js";
import { saveConfig } from "../dist/state.js";
import { validateContract } from "../dist/contracts.js";
import { singleGraph } from "../dist/graph/compiler.js";
import { planRun } from "../dist/nodes/planner.js";
import { approvePlan } from "../dist/interaction/approval.js";
import { startRun } from "../dist/runtime/supervisor.js";
import { startDashboard } from "../dist/dashboard.js";
const root = await mkdtemp(join(tmpdir(), "ralph-ui-fixture-"));
await git(root, ["init"]);
await git(root, ["config", "user.email", "test@example.invalid"]);
await git(root, ["config", "user.name", "Test"]);
await writeFile(join(root, "README.md"), "Fixture\n");
await git(root, ["add", "."]);
await git(root, ["commit", "-m", "baseline"]);
const route = {
  connectionId: "mock:process",
  provider: "mock",
  modelId: "mock-1",
  displayName: "Mock fixture",
  reasoningEffort: "high",
  score: 100,
  source: "override",
};
const routes = Object.fromEntries(
  [
    "planning_architecture",
    "frontend_visual",
    "backend_core",
    "tdd_debugging",
    "static_review",
    "delivery_evidence",
    "contractPlanner",
    "critic",
    "metaPrompter",
    "adjudicator",
    "worker",
    "router",
  ].map((k) => [k, [route]]),
);
const commands = [
  `node -e "require('fs').accessSync('ralph-smoke.txt')"`,
  `node -e "require('fs').accessSync('right.txt')"`,
  "git diff --check",
];
await saveConfig(root, {
  schemaVersion: 1,
  projectRoot: root,
  preset: "balanced",
  initializedAt: new Date().toISOString(),
  connections: [
    {
      id: route.connectionId,
      adapter: "generic-process",
      provider: "mock",
      enabled: true,
      mode: "process",
      command: [process.execPath, resolve("tests/fixtures/mock-agent.mjs")],
    },
  ],
  routes,
  overrides: {},
  verifierCommands: commands,
  catalogVersion: 2,
});
const contract = validateContract(
  {
    taskType: "backend_core",
    goal: "Build a verified artifact",
    include: ["ralph-smoke.txt", "right.txt"],
    exclude: [".git/**"],
    acceptanceCriteria: ["Artifact exists and checks pass"],
    verifierCommands: commands,
    requiredArtifacts: ["ralph-smoke.txt", "right.txt"],
  },
  root,
);
const graph = singleGraph("fixture-proposal", {
  taskType: contract.taskType,
  goal: contract.goal,
  readPaths: ["**"],
  writePaths: ["ralph-smoke.txt"],
  acceptanceCriteria: ["Artifact exists"],
  requiredCapabilities: [],
  inputArtifacts: [],
  verifierIds: [commands[0]],
  budget: { maxIterations: 6 },
});
graph.nodes.splice(1, 0, {
  ...graph.nodes[0],
  nodeId: "right",
  writePaths: ["right.txt"],
  verifierIds: [commands[1]],
});
graph.edges.push({ from: "right", to: "integrate", kind: "artifact" });
graph.nodes.find((n) => n.kind === "validate").verifierIds = commands;
const plan = await planRun(root, contract.goal, { contract, graph });
await startRun(approvePlan(plan));
const dashboard = await startDashboard(root, {
  port: Number(process.env.RALPH_TEST_PORT ?? 7349),
});
console.log(JSON.stringify({ url: dashboard.url, root, runId: plan.runId }));

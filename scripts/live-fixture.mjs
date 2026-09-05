import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { git } from "../dist/workspace/manager.js";
import { singleGraph } from "../dist/graph/compiler.js";

export const task = {
  taskType: "backend_core",
  goal: "Implement two independent ESM utilities. left.mjs exports sumNonNegative(values): require an array of finite non-negative numbers; return their sum (empty array => 0); otherwise throw TypeError. right.mjs exports normalizeLabel(value): require a string, trim it, collapse consecutive ASCII whitespace to one space and lowercase; an empty result or non-string throws TypeError. Preserve the exports. No dependencies, network, commits, pushes or other file changes.",
  include: ["left.mjs", "right.mjs"], exclude: [".git/**", "*.test.mjs"],
  acceptanceCriteria: ["Both documented functions satisfy all valid and invalid input cases", "Only the two allowed modules change", "Syntax checks and git diff --check pass"],
  verifierCommands: ["node --test left.test.mjs", "node --test right.test.mjs", "node --check left.mjs", "node --check right.mjs", "git diff --check"],
  requiredArtifacts: ["left.mjs", "right.mjs"], executionProfile: "balanced",
};
export const solutions = {
  "left.mjs": "export function sumNonNegative(values) { if (!Array.isArray(values) || values.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw new TypeError('Expected finite non-negative numbers'); return values.reduce((sum, v) => sum + v, 0); }\n",
  "right.mjs": "export function normalizeLabel(value) { if (typeof value !== 'string') throw new TypeError('Expected string'); const result = value.trim().replace(/[\\t\\n\\v\\f\\r ]+/g, ' ').toLowerCase(); if (!result) throw new TypeError('Empty label'); return result; }\n",
};
// Public, frozen acceptance examples become recorded verifier evidence for both
// runtimes. The separate oracle still evaluates additional input combinations.
export const acceptanceTests = {
  "left.test.mjs": `import assert from 'node:assert/strict';
import { sumNonNegative } from './left.mjs';
assert.equal(sumNonNegative([]), 0);
assert.equal(sumNonNegative([2, 3.5]), 5.5);
for (const invalid of [undefined, [-2], [Infinity], ['3']]) assert.throws(() => sumNonNegative(invalid), TypeError);
`,
  "right.test.mjs": `import assert from 'node:assert/strict';
import { normalizeLabel } from './right.mjs';
assert.equal(normalizeLabel('  Hello\\tWORLD  '), 'hello world');
for (const invalid of [undefined, 7, '', '   ']) assert.throws(() => normalizeLabel(invalid), TypeError);
`,
};
export async function fixture(root) {
  await mkdir(root, { recursive: true });
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "release@example.invalid"]);
  await git(root, ["config", "user.name", "Release fixture"]);
  for (const [file, name] of [["left.mjs", "sumNonNegative"], ["right.mjs", "normalizeLabel"]])
    await writeFile(join(root, file), `export function ${name}(value) { throw new Error('Not implemented'); }\n`);
  for (const [file, contents] of Object.entries(acceptanceTests)) await writeFile(join(root, file), contents);
  await git(root, ["add", "."]); await git(root, ["commit", "-m", "Frozen comparison fixture"]);
}
export function graphFor(contract) {
  const graph = singleGraph("comparison", { taskType: task.taskType, goal: task.goal,
    readPaths: ["**"], writePaths: ["left.mjs"], acceptanceCriteria: task.acceptanceCriteria,
    requiredCapabilities: [], inputArtifacts: [], verifierIds: [task.verifierCommands[0], task.verifierCommands[2], "git diff --check"], budget: { maxIterations: 6 } });
  graph.nodes[0].nodeId = "left";
  graph.nodes[0].goal = "Implement only left.mjs: sumNonNegative must validate an array of finite non-negative numbers and return their sum; invalid input throws TypeError. The other branch owns right.mjs.";
  graph.nodes[0].acceptanceCriteria = ["sumNonNegative satisfies every valid and invalid input case in the shared contract", "Only left.mjs changes"];
  graph.edges[0].from = "left";
  graph.nodes.splice(1, 0, { ...graph.nodes[0], nodeId: "right", goal: "Implement only right.mjs: normalizeLabel requires a string, trims and collapses ASCII whitespace, lowercases, and throws TypeError for non-string or empty results. The other branch owns left.mjs.", acceptanceCriteria: ["normalizeLabel satisfies every valid and invalid input case in the shared contract", "Only right.mjs changes"], writePaths: ["right.mjs"], verifierIds: [task.verifierCommands[1], task.verifierCommands[3], "git diff --check"] });
  graph.edges.push({ from: "right", to: "integrate", kind: "artifact" });
  graph.nodes.find(n => n.kind === "validate").verifierIds = contract.verifierCommands;
  return graph;
}
/** This oracle is outside both model workspaces and never added to their prompts. */
export async function oracle(root) {
  const { sumNonNegative: sum } = await import(pathToFileURL(join(root, "left.mjs")).href);
  const { normalizeLabel: label } = await import(pathToFileURL(join(root, "right.mjs")).href);
  assert.equal(sum([]), 0); assert.equal(sum([0, 1, 2.5, 8]), 11.5);
  for (const invalid of [null, {}, "1", [-1], [NaN], [Infinity], ["1"], [true]]) assert.throws(() => sum(invalid), TypeError);
  assert.equal(label("  HeLLo\t\nWORLD  "), "hello world"); assert.equal(label("ONE"), "one");
  for (const invalid of [null, 1, [], {}, "", "\t\n  "]) assert.throws(() => label(invalid), TypeError);
  return true;
}

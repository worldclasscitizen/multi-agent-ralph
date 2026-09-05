#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input.trim());
const criterionIds = [
  "contract_evidence",
  "deterministic_verification",
  "regression_scope_safety",
  "reproducibility",
  "api_contract_correctness",
  "data_business_integrity",
  "error_security_handling",
  "integration_evidence",
];
const gateIds = [
  "worker_execution_failed",
  "deterministic_verifier_failed",
  "secret_or_user_data_exposure",
  "core_placeholder_claimed_complete",
  "tests_weakened",
  "destructive_out_of_scope_change",
  "core_contract_broken",
];
let text = "";
if (request.role === "contractPlanner") {
  text = JSON.stringify({
    taskType: "backend_core",
    goal: "Create a smoke artifact",
    include: ["ralph-smoke.txt"],
    exclude: [".git/**"],
    requirements: ["Write the artifact"],
    acceptanceCriteria: ["ralph-smoke.txt exists"],
    verifierCommands: ["test -f ralph-smoke.txt", "git diff --check"],
    requiredArtifacts: ["ralph-smoke.txt"],
    attachments: [],
    constraints: [],
    executionProfile: "balanced",
  });
} else if (request.nodeId === "contract-critic") {
  text = JSON.stringify({
    status: "pass",
    issues: [],
    evidence: ["The mock contract is bounded and verifiable."],
  });
} else if (request.role === "critic" || request.role === "adjudicator") {
  text = JSON.stringify({
    criteria: criterionIds.map((id) => ({
      id,
      level: "complete",
      evidence: ["mock evidence"],
    })),
    hardGates: gateIds.map((id) => ({
      id,
      status: "pass",
      evidence: ["mock evidence"],
    })),
    findings: [],
  });
} else if (request.role === "router") {
  text = JSON.stringify({
    connectionId: "mock:process",
    modelId: "mock-1",
    reasoningEffort: "high",
    sessionPolicy: "fresh",
    rationale: "Use the only verified candidate.",
  });
} else if (request.role === "metaPrompter") {
  text = JSON.stringify({
    workerInstructions: "Write ralph-smoke.txt.",
    guardrailCandidate: "",
  });
} else if (request.role === "worker") {
  if (request.nodeId === "left") await writeFile("left.txt", "initial\n");
  else if (request.nodeId === "right") await writeFile("right.txt", "ok\n");
  else if (request.nodeId === "repair") await writeFile("left.txt", "ok\n");
  else await writeFile("ralph-smoke.txt", "ok\n");
  text = "ralph-smoke.txt를 작성했습니다.";
}
process.stdout.write(
  `${JSON.stringify({ text, exitCode: 0, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })}\n`,
);

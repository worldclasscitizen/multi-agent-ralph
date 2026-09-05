import { describe, expect, it } from "vitest";
import {
  approveContract,
  assertApproved,
  validateContract,
  validateContractDraft,
} from "../src/contracts.js";
import { contractPlannerPrompt } from "../src/prompts.js";
import Ajv from "ajv";
import {
  classifyProviderError,
  emptyResponseError,
} from "../src/providers/errors.js";

describe("approval contract integrity", () => {
  it("gives the model the same concrete contract shape used by the draft validator", () => {
    const prompt = contractPlannerPrompt(
      "Implement two independent modules",
      "/fixture",
    );
    const schema = JSON.parse(
      prompt.match(/TaskContract JSON Schema:\n([^\n]+)/)![1]!,
    );
    const accepts = new Ajv.default({ strict: false }).compile(schema);
    const valid = {
      taskType: "backend_core",
      goal: "Implement two modules",
      include: ["left.mjs", "right.mjs"],
      exclude: ["*.test.mjs"],
      acceptanceCriteria: ["Behavior tests pass"],
      verifierCommands: ["node --test left.test.mjs"],
      requiredArtifacts: ["left.mjs", "right.mjs"],
      executionProfile: "balanced",
    };
    expect(accepts(valid)).toBe(true);
    expect(validateContractDraft(valid, "/fixture").goal).toBe(valid.goal);
    // Shape observed twice in the real failed planning attempt. The runtime must
    // reject it with the actual missing field name, never silently rename it.
    const { goal, ...rest } = valid;
    const observed = {
      ...rest,
      objective: goal,
      workers: [{ id: "left" }],
      constraints: { noNetwork: true },
    };
    expect(accepts(observed)).toBe(false);
    expect(() => validateContractDraft(observed, "/fixture")).toThrow(/goal/);
    expect(() =>
      validateContractDraft({ ...valid, verifierCommands: {} }, "/fixture"),
    ).toThrow(/verifierCommands/);
    expect(() =>
      validateContractDraft({ ...valid, approvedHash: "invented" }, "/fixture"),
    ).toThrow(/additional/);
  });
  it("accepts the unchanged approved contract and rejects a changed goal", () => {
    const root = "/tmp/example-project";
    const approved = approveContract(
      validateContract(
        {
          taskType: "backend_core",
          goal: "검증 가능한 기능을 구현합니다.",
          acceptanceCriteria: ["테스트가 통과합니다."],
          executionProfile: "balanced",
        },
        root,
      ),
    );
    expect(() => assertApproved(approved)).not.toThrow();
    expect(() =>
      assertApproved({ ...approved, goal: "승인 후 바뀐 목표" }),
    ).toThrow(/hash/);
  });
});

describe("provider error policy", () => {
  it.each([
    [{ statusCode: 429 }, "rate_limit", true],
    [{ message: "quota exhausted" }, "quota", true],
    [{ message: "request timed out" }, "timeout", true],
    [{ statusCode: 503 }, "server_error", true],
    [{ message: "service overloaded" }, "overloaded", true],
    [{ statusCode: 401 }, "authentication", false],
    [{ message: "safety policy refusal" }, "policy_denial", false],
    [{ statusCode: 400 }, "invalid_request", false],
  ] as const)("classifies %o as %s", (input, kind, retryable) => {
    expect(classifyProviderError(input)).toMatchObject({ kind, retryable });
  });

  it("treats an exit-0 empty response as retryable", () => {
    expect(emptyResponseError("critic")).toMatchObject({
      kind: "empty_response",
      retryable: true,
    });
  });
});

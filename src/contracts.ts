import { randomUUID } from "node:crypto";
import type { ExecutionProfile, TaskContract, TaskType } from "./types.js";
import { TASK_TYPES } from "./types.js";
import { RalphError, sha256 } from "./util.js";
import { Type, type Static } from "@sinclair/typebox";
import Ajv from "ajv";

/** The model receives this same schema that validates its unapproved output. */
export const TaskContractDraftSchema = Type.Object(
  {
    taskType: Type.Union(TASK_TYPES.map((value) => Type.Literal(value))),
    goal: Type.String({
      minLength: 1,
      description:
        "One explicit task goal; the field is named goal, not objective.",
    }),
    include: Type.Array(Type.String(), {
      description: "Allowed file write paths",
    }),
    exclude: Type.Array(Type.String(), {
      description: "Paths that must never change",
    }),
    acceptanceCriteria: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
    }),
    verifierCommands: Type.Array(Type.String()),
    requiredArtifacts: Type.Array(Type.String()),
    executionProfile: Type.Union(
      ["balanced", "quality", "fast", "budget"].map((value) =>
        Type.Literal(value),
      ),
    ),
    requirements: Type.Optional(Type.Array(Type.String())),
    attachments: Type.Optional(Type.Array(Type.String())),
    constraints: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);
export type TaskContractDraft = Static<typeof TaskContractDraftSchema>;
const draftAjv = new Ajv.default({ allErrors: true, strict: false });
const validateDraft = draftAjv.compile(TaskContractDraftSchema);
export function validateContractDraft(
  input: unknown,
  projectRoot: string,
): TaskContract {
  if (!validateDraft(input))
    throw new RalphError(
      `TaskContract JSON schema: ${draftAjv.errorsText(validateDraft.errors)}`,
      "schema_error",
    );
  return validateContract(input, projectRoot);
}

export function validateContract(
  input: unknown,
  projectRoot: string,
): TaskContract {
  if (!input || typeof input !== "object")
    throw new RalphError("작업 계약이 JSON 객체가 아닙니다.", "schema_error");
  const row = input as Record<string, unknown>;
  if (!TASK_TYPES.includes(row.taskType as TaskType))
    throw new RalphError("taskType이 올바르지 않습니다.", "schema_error");
  const profiles: ExecutionProfile[] = [
    "balanced",
    "quality",
    "fast",
    "budget",
  ];
  const list = (key: string): string[] => {
    if (row[key] === undefined) return [];
    if (
      !Array.isArray(row[key]) ||
      !(row[key] as unknown[]).every((value) => typeof value === "string")
    )
      throw new RalphError(
        `${key}는 문자열 배열이어야 합니다.`,
        "schema_error",
      );
    return row[key] as string[];
  };
  if (typeof row.goal !== "string" || !row.goal.trim())
    throw new RalphError("작업 목표가 비어 있습니다.", "schema_error");
  const profile = profiles.includes(row.executionProfile as ExecutionProfile)
    ? (row.executionProfile as ExecutionProfile)
    : "balanced";
  const contract: TaskContract = {
    id: typeof row.id === "string" && row.id ? row.id : randomUUID(),
    taskType: row.taskType as TaskType,
    goal: row.goal.trim(),
    include: list("include"),
    exclude: list("exclude"),
    requirements: list("requirements"),
    acceptanceCriteria: list("acceptanceCriteria"),
    verifierCommands: list("verifierCommands"),
    requiredArtifacts: list("requiredArtifacts"),
    attachments: list("attachments"),
    constraints: list("constraints"),
    executionProfile: profile,
    projectRoot,
    ...(typeof row.modelOverride === "string" && row.modelOverride.trim()
      ? { modelOverride: row.modelOverride.trim() }
      : {}),
  };
  if (!contract.acceptanceCriteria.length)
    throw new RalphError("최소 하나의 완료 기준이 필요합니다.", "schema_error");
  return contract;
}

export function contractHash(contract: TaskContract): string {
  const { approvedHash: _hash, approvedAt: _at, ...unsigned } = contract;
  return sha256(JSON.stringify(unsigned));
}

export function approveContract(contract: TaskContract): TaskContract {
  const approvedAt = new Date().toISOString();
  const approvedHash = contractHash(contract);
  return { ...contract, approvedHash, approvedAt };
}

export function assertApproved(contract: TaskContract): void {
  if (
    !contract.approvedHash ||
    contract.approvedHash !== contractHash(contract)
  )
    throw new RalphError(
      "승인된 작업 계약의 hash가 일치하지 않습니다.",
      "contract_tampered",
      4,
    );
}

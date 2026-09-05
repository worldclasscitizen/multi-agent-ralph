import { Type, type Static } from "@sinclair/typebox";
import { RalphError } from "../util.js";
export const ClarificationSchema = Type.Object(
  {
    id: Type.String(),
    runId: Type.String(),
    reason: Type.Union(
      [
        "ambiguous_goal",
        "missing_constraint",
        "scope_change",
        "capability_gap",
      ].map((x) => Type.Literal(x)),
    ),
    questions: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          prompt: Type.String(),
          options: Type.Optional(Type.Array(Type.String())),
          required: Type.Boolean(),
          defaultValue: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 3 },
    ),
    blocksExecution: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ClarificationRequest = Static<typeof ClarificationSchema>;
export function validateResponse(
  question: ClarificationRequest,
  answers: Record<string, string>,
): void {
  if (
    !answers ||
    typeof answers !== "object" ||
    Array.isArray(answers) ||
    Object.values(answers).some((v) => typeof v !== "string")
  )
    throw new RalphError("Answers must be a string map", "invalid_response", 4);
  for (const q of question.questions)
    if (q.required && !answers[q.id]?.trim())
      throw new RalphError(`Answer required: ${q.id}`, "input_required", 10);
  if (
    Object.keys(answers).some(
      (id) => !question.questions.some((q) => q.id === id),
    )
  )
    throw new RalphError("Unknown question ID", "invalid_response", 4);
}

import { readFile, rename, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RunStore } from "../storage/run-store.js";
import { durableWrite } from "../storage/journal.js";
import { safeId, digest } from "../graph/schema.js";
import { statePaths } from "../state.js";
import { planRun } from "../nodes/planner.js";
import {
  validateResponse,
  type ClarificationRequest,
} from "./clarification.js";
import type { ExecutionPlan } from "./approval.js";
import { RalphError } from "../util.js";
interface ResponseReceipt {
  answerDigest: string;
  status: "pending" | "completed" | "failed";
  plan?: ExecutionPlan;
  error?: string;
}
/** Persist intent before planning. A duplicate response never starts another model call. */
export async function submitResponse(
  projectRoot: string,
  runId: string,
  questionId: string,
  answers: Record<string, string>,
): Promise<ExecutionPlan> {
  safeId(questionId);
  const store = new RunStore((await statePaths(projectRoot)).root, runId);
  const path = join(store.directory, "question.json");
  const receiptPath = join(store.directory, `response-${questionId}.json`);
  const answerDigest = digest({ runId, questionId, answers });
  const existing = async (): Promise<ExecutionPlan | undefined> => {
    let receipt: ResponseReceipt;
    try {
      receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    if (receipt.answerDigest !== answerDigest)
      throw new RalphError(
        "Response ID reused with different answers",
        "revision_conflict",
        4,
      );
    if (receipt.status === "completed" && receipt.plan) return receipt.plan;
    throw new RalphError(
      receipt.status === "pending"
        ? "Response is already being planned or needs interruption inspection"
        : `Previous response needs the latest question: ${receipt.error}`,
      "input_required",
      10,
    );
  };
  const cached = await existing();
  if (cached) return cached;
  const question = JSON.parse(
    await readFile(path, "utf8"),
  ) as ClarificationRequest;
  if (question.id !== questionId || question.runId !== runId)
    throw new RalphError("Question changed", "revision_conflict", 4);
  validateResponse(question, answers);
  if ((await store.state()).status !== "awaiting_input")
    throw new RalphError(
      "Run is not awaiting a response",
      "revision_conflict",
      4,
    );
  const context = JSON.parse(
    await readFile(join(store.directory, "context.json"), "utf8"),
  );
  const temporary = join(store.directory, `response-${randomUUID()}.tmp`);
  await durableWrite(
    temporary,
    JSON.stringify({
      answerDigest,
      status: "pending",
    } satisfies ResponseReceipt),
  );
  try {
    await link(temporary, receiptPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return (await existing())!;
  } finally {
    await unlink(temporary);
  }
  try {
    // Archive this exact question before the planner can create a replacement.
    await rename(
      path,
      join(store.directory, `question-${questionId}-answered.json`),
    );
    const plan = await planRun(
      projectRoot,
      `${context.request}\nClarification answers: ${JSON.stringify(answers)}`,
      { runId },
    );
    await durableWrite(
      receiptPath,
      JSON.stringify({
        answerDigest,
        status: "completed",
        plan,
      } satisfies ResponseReceipt),
    );
    return plan;
  } catch (e) {
    await durableWrite(
      receiptPath,
      JSON.stringify({
        answerDigest,
        status: "failed",
        error: String(e),
      } satisfies ResponseReceipt),
    );
    throw e;
  }
}

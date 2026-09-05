import { it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git } from "../src/workspace/manager.js";
import { statePaths } from "../src/state.js";
import { RunStore } from "../src/storage/run-store.js";
import { submitResponse } from "../src/interaction/responses.js";
import { validateResponse } from "../src/interaction/clarification.js";
import { planRun } from "../src/nodes/planner.js";
vi.mock("../src/nodes/planner.js", () => ({ planRun: vi.fn() }));
beforeEach(() => {
  vi.mocked(planRun).mockReset();
});
const question = {
  id: "question-1",
  runId: "response-test",
  reason: "ambiguous_goal" as const,
  questions: [{ id: "target", prompt: "Target file?", required: true }],
  blocksExecution: true,
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ralph-response-"));
  await git(root, ["init"]);
  const store = new RunStore((await statePaths(root)).root, question.runId);
  await store.acquire();
  await store.append(
    { type: "run.status", payload: { status: "awaiting_input" } },
    1,
  );
  await store.release();
  await writeFile(
    join(store.directory, "question.json"),
    JSON.stringify(question),
  );
  await writeFile(
    join(store.directory, "context.json"),
    JSON.stringify({ request: "Update target" }),
  );
  return { root, store };
}
it("requires explicit answers, rejects unknown IDs and non-string values", () => {
  for (const answers of [
    {},
    { unknown: "value" },
    { target: 12 },
    { target: "  " },
    ["answer"],
  ])
    expect(() => validateResponse(question, answers as any)).toThrow();
  expect(() =>
    validateResponse(question, { target: "src/main.ts" }),
  ).not.toThrow();
});
it("returns the same plan for duplicate answers and rejects changed payloads", async () => {
  const { root, store } = await fixture(),
    plan = { runId: question.runId, graph: { revision: 2 } } as any;
  vi.mocked(planRun).mockResolvedValue(plan);
  expect(
    await submitResponse(root, question.runId, question.id, { target: "a.ts" }),
  ).toEqual(plan);
  expect(
    await submitResponse(root, question.runId, question.id, { target: "a.ts" }),
  ).toEqual(plan);
  await expect(
    submitResponse(root, question.runId, question.id, { target: "b.ts" }),
  ).rejects.toThrow(/different answers/);
  expect(planRun).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(
      await readFile(
        join(store.directory, "question-question-1-answered.json"),
        "utf8",
      ),
    ),
  ).toEqual(question);
});
it("concurrent response delivery starts only one planner", async () => {
  const { root } = await fixture();
  let complete!: (p: any) => void;
  vi.mocked(planRun).mockImplementation(
    () =>
      new Promise((r) => {
        complete = r;
      }),
  );
  const first = submitResponse(root, question.runId, question.id, {
    target: "a.ts",
  });
  await vi.waitFor(() => expect(planRun).toHaveBeenCalledTimes(1));
  await expect(
    submitResponse(root, question.runId, question.id, { target: "a.ts" }),
  ).rejects.toThrow(/already being planned/);
  complete({ runId: question.runId });
  await first;
  expect(planRun).toHaveBeenCalledTimes(1);
});
it("preserves a replacement question after unsuccessful replanning", async () => {
  const { root, store } = await fixture();
  vi.mocked(planRun).mockImplementation(async () => {
    await writeFile(
      join(store.directory, "question.json"),
      JSON.stringify({ ...question, id: "question-2" }),
    );
    throw Error("More context needed");
  });
  await expect(
    submitResponse(root, question.runId, question.id, { target: "a.ts" }),
  ).rejects.toThrow(/More context/);
  expect(
    JSON.parse(await readFile(join(store.directory, "question.json"), "utf8"))
      .id,
  ).toBe("question-2");
  await expect(
    submitResponse(root, question.runId, question.id, { target: "a.ts" }),
  ).rejects.toThrow(/latest question/);
  expect(planRun).toHaveBeenCalledTimes(1);
});
it("refuses obsolete questions before starting planning", async () => {
  const { root } = await fixture();
  await expect(
    submitResponse(root, question.runId, "old-question", { target: "a.ts" }),
  ).rejects.toThrow(/Question changed/);
  expect(planRun).not.toHaveBeenCalled();
});

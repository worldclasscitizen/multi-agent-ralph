import { submitResponse } from "./interaction/responses.js";
import {
  inspectInterruptedRun,
  reconcileInterruptedRun,
} from "./runtime/inspection.js";
import { readFile, open, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { findGitRoot } from "./git.js";
import { planRun } from "./nodes/planner.js";
import { approvePlan, type ExecutionPlan } from "./interaction/approval.js";
import { startRun, resumeGraphRun, storeFor } from "./runtime/supervisor.js";
import { submitCommand } from "./runtime/commands.js";
import { listGraphRuns } from "./dashboard/api.js";
import { aggregateUsage } from "./gateway/metrics.js";
import { durableWrite } from "./storage/journal.js";
import {
  validateResponse,
  type ClarificationRequest,
} from "./interaction/clarification.js";
import { legacyPlanInput, migrateGraphState } from "./migration/graph.js";
import { RalphError } from "./util.js";
const output = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const option = (args: string[], name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith("--"))
    throw new RalphError(`Missing ${name} value`, "invalid_argument", 2);
  args.splice(i, 2);
  return value;
};
async function stdin() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 2_000_000)
      throw new RalphError("Input too large", "invalid_argument", 2);
  }
  return text;
}
async function detach(root: string, runId: string, resume: boolean) {
  const store = await storeFor(root, runId);
  await mkdir(store.directory, { recursive: true });
  const out = await open(join(store.directory, "runner.log"), "a", 0o600);
  try {
    const child = spawn(
      process.execPath,
      [
        process.argv[1]!,
        resume ? "__graph-resume" : "__graph-execute",
        "--project",
        root,
        runId,
      ],
      { detached: true, stdio: ["ignore", out.fd, out.fd], windowsHide: true },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } finally {
    await out.close();
  }
}
export async function graphCli(
  command: string,
  original: string[],
): Promise<boolean> {
  const supported = [
    "plan",
    "run",
    "graph",
    "explain",
    "respond",
    "__graph-execute",
    "__graph-resume",
    "status",
    "stop",
    "resume",
    "usage",
    "logs",
    "inspect-interruption",
  ];
  if (command === "migrate" && !original.includes("--to")) return false;
  if (!supported.includes(command) && command !== "migrate") return false;
  const args = [...original],
    root = await findGitRoot(option(args, "--project") ?? process.cwd());
  const asJson = flag(args, "--json");
  if (command === "inspect-interruption") {
    const accepted = option(args, "--accept"),
      stopped = flag(args, "--confirm-stopped");
    const runId = args.shift();
    if (!runId) throw new RalphError("Run ID required", "invalid_argument", 2);
    output(
      accepted
        ? await reconcileInterruptedRun(root, runId, accepted, stopped)
        : await inspectInterruptedRun(root, runId),
    );
    return true;
  }
  if (command === "migrate") {
    const to = option(args, "--to");
    if (to !== "0.3")
      throw new RalphError("Supported target: 0.3", "invalid_argument", 2);
    output(await migrateGraphState(root, flag(args, "--dry-run")));
    return true;
  }
  if (command === "__graph-execute" || command === "__graph-resume") {
    const id = args[0]!;
    const store = await storeFor(root, id);
    const state =
      command === "__graph-resume"
        ? await resumeGraphRun(root, id)
        : await startRun(
            JSON.parse(
              await readFile(join(store.directory, "plan.json"), "utf8"),
            ),
          );
    output(state);
    return true;
  }
  if (command === "plan" || command === "run") {
    const yes = flag(args, "--yes"),
      planStdin = flag(args, "--plan-stdin"),
      requestStdin = flag(args, "--stdin"),
      contractStdin = flag(args, "--contract-stdin");
    const legacyId = option(args, "--from-run");
    const hostPath = option(args, "--host-context");
    const host = hostPath
      ? JSON.parse(await readFile(hostPath, "utf8"))
      : undefined;
    const existing = option(args, "--plan"),
      mode = option(args, "--mode") as
        "answer" | "single" | "graph" | undefined;
    const eventFormat = option(args, "--events");
    if (mode && !["answer", "single", "graph"].includes(mode))
      throw new RalphError("Invalid execution mode", "invalid_argument", 2);
    if (yes && !planStdin && !existing)
      throw new RalphError(
        "Use ralph plan, review its JSON, then run --plan-stdin --yes",
        "approval_required",
        10,
      );
    if (contractStdin)
      throw new RalphError(
        "v0.2 contracts require a new graph plan; use ralph plan and --plan-stdin",
        "migration_required",
        10,
      );
    let plan: ExecutionPlan;
    if (planStdin) plan = JSON.parse(await stdin());
    else if (existing)
      plan = JSON.parse(
        await readFile(
          join((await storeFor(root, existing)).directory, "plan.json"),
          "utf8",
        ),
      );
    else {
      const legacy = legacyId
        ? await legacyPlanInput(root, legacyId)
        : undefined;
      const request =
        legacy?.request ?? (requestStdin ? await stdin() : args.join(" "));
      if (!request.trim())
        throw new RalphError("A request is required", "invalid_argument", 2);
      plan = await planRun(root, request, {
        mode,
        host,
        ...(legacy
          ? { contract: legacy.contract, originRunId: legacy.originRunId }
          : {}),
      });
    }
    if (plan.projectRoot !== root)
      throw new RalphError("Plan project mismatch", "approval_required", 10);
    if (command === "plan") {
      output(plan);
      return true;
    }
    if (!yes && plan.mode !== "answer") {
      process.stderr.write(`${JSON.stringify(plan, null, 2)}\n`);
      if (!process.stdin.isTTY) {
        output({ status: "awaiting_input", runId: plan.runId, plan });
        process.exitCode = 10;
        return true;
      }
      const prompt = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        const answer = await prompt.question(
          "Approve this exact graph, scope and budget? [y/N] ",
        );
        if (!/^y(es)?$/i.test(answer.trim()))
          throw new RalphError("Approval declined", "approval_required", 10);
      } finally {
        prompt.close();
      }
    }
    const approved = approvePlan(plan);
    const store = await storeFor(root, plan.runId);
    await durableWrite(
      join(store.directory, "plan.json"),
      JSON.stringify(approved),
    );
    const initialSeq = (await store.state()).seq;
    await detach(root, plan.runId, false);
    let after = 0,
      started = false;
    for (let tick = 0; tick < 10000; tick++) {
      await new Promise((r) => setTimeout(r, 300));
      const state = await store.state();
      if (
        state.seq > initialSeq ||
        state.status === "running" ||
        state.status === "completed" ||
        state.status === "failed"
      )
        started = true;
      if (eventFormat === "ndjson")
        for (const event of await store.readAfter(after)) {
          after = event.seq;
          output(event);
        }
      if (started && state.status !== "running") {
        output(state);
        process.exitCode = state.status === "completed" ? 0 : 10;
        return true;
      }
      if (tick > 100 && !started) {
        output({
          runId: plan.runId,
          status: state.status,
          message: "Runner did not start; inspect runner.log",
        });
        process.exitCode = 10;
        return true;
      }
    }
    return true;
  }
  const runs = await listGraphRuns(root);
  const id =
    option(args, "--run") ??
    args.find((x) => !x.startsWith("--") && x !== "show") ??
    runs.find((r) => !r.legacy)?.runId;
  if (command === "status") {
    const show = async () => {
      const list = await listGraphRuns(root);
      output(
        id ? list.find((r) => r.runId === id) : (list[0] ?? { status: "idle" }),
      );
    };
    await show();
    if (flag(args, "--watch")) {
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => void show(), 1000);
        process.once("SIGINT", () => {
          clearInterval(timer);
          resolve();
        });
      });
    }
    return true;
  }
  if (command === "usage") {
    const events = [];
    for (const run of runs)
      if (!run.legacy)
        events.push(...(await (await storeFor(root, run.runId)).readAfter()));
    output(aggregateUsage(events));
    return true;
  }
  if (!id) throw new RalphError("No graph run found", "run_not_found", 2);
  const store = await storeFor(root, id);
  if (command === "graph") {
    const format = option(args, "--format") ?? "json";
    const graph = await store.graph();
    if (format === "mermaid")
      process.stdout.write(
        `flowchart LR\n${graph.nodes.map((n) => `  ${n.nodeId.replaceAll("-", "_")}["${n.nodeId}"]`).join("\n")}\n${graph.edges.map((e) => `  ${e.from.replaceAll("-", "_")} --> ${e.to.replaceAll("-", "_")}`).join("\n")}\n`,
      );
    else output(graph);
    return true;
  }
  if (command === "explain") {
    const node = option(args, "--node");
    output({
      state: (await store.state()).nodes[node ?? ""],
      events: (await store.readAfter()).filter(
        (e) => "nodeId" in e.payload && e.payload.nodeId === node,
      ),
    });
    return true;
  }
  if (command === "logs") {
    let after = 0;
    const show = async () => {
      for (const event of await store.readAfter(after)) {
        after = event.seq;
        output(event);
      }
    };
    await show();
    if (flag(args, "--follow"))
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => void show(), 500);
        process.once("SIGINT", () => {
          clearInterval(timer);
          resolve();
        });
      });
    return true;
  }
  if (command === "stop") {
    await submitCommand(store, {
      commandId: randomUUID(),
      expectedRevision: (await store.state()).revision,
      type: flag(args, "--force") ? "cancel" : "stop",
    });
    output({ runId: id, requested: true });
    return true;
  }
  if (command === "resume") {
    await detach(root, id, true);
    output({ runId: id, requested: true });
    return true;
  }
  if (command === "respond") {
    const questionId = option(args, "--request");
    if (!questionId)
      throw new RalphError("--request is required", "invalid_argument", 2);
    output(
      await submitResponse(root, id, questionId, JSON.parse(await stdin())),
    );
    return true;
  }
  return false;
}

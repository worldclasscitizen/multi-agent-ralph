import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { statePaths, loadConfig } from "../state.js";
import { replay, RunStore } from "../storage/run-store.js";
import { collectRoutingHistory } from "../gateway/history.js";
import { wilsonLower } from "../gateway/metrics.js";
import { aggregateUsage } from "../gateway/metrics.js";
import { submitCommand, type RunCommand } from "../runtime/commands.js";
import { RalphError } from "../util.js";
import { createAdapter } from "../providers/index.js";
import { probeProvider } from "../gateway/capabilities.js";
export const controlToken = randomUUID();
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
export async function listGraphRuns(projectRoot: string) {
  const paths = await statePaths(projectRoot);
  const names = await readdir(paths.runs).catch(() => []);
  const rows = [];
  for (const name of names) {
    try {
      const plan = JSON.parse(
        await readFile(join(paths.runs, name, "plan.json"), "utf8"),
      );
      const store = new RunStore(paths.root, name);
      const state = await store.state();
      rows.push({
        ...state,
        goal: plan.contract.goal,
        mode: plan.mode,
        legacy: false,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      try {
        const old = JSON.parse(
          await readFile(join(paths.runs, name, "state.json"), "utf8"),
        );
        rows.push({ ...old, runId: old.id, goal: old.taskType, legacy: true });
      } catch {
        /* Drafts may not yet have a legacy state. */
      }
    }
  }
  return rows.sort((a, b) =>
    String(b.startedAt).localeCompare(String(a.startedAt)),
  );
}
export async function handleGraphApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  root: string,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/v2/")) return false;
  try {
    const expected = `http://${req.headers.host}`;
    if (req.headers.origin && req.headers.origin !== expected) {
      json(res, 403, { error: "Origin not allowed" });
      return true;
    }
    if (url.pathname === "/api/v2/session") {
      json(res, 200, { controlToken });
      return true;
    }
    if (req.method !== "GET" && req.headers["x-ralph-token"] !== controlToken) {
      json(res, 403, { error: "Control token required" });
      return true;
    }
    const paths = await statePaths(root);
    if (url.pathname === "/api/v2/runs") {
      const runs = await listGraphRuns(root);
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const limit = Math.min(
        100,
        Math.max(1, Number(url.searchParams.get("limit")) || 30),
      );
      json(res, 200, {
        runs: runs.slice(offset, offset + limit),
        total: runs.length,
      });
      return true;
    }
    if (url.pathname === "/api/v2/providers") {
      const config = await loadConfig(root);
      json(
        res,
        200,
        await Promise.all(config.connections.map(async (c) => ({
          id: c.id,
          provider: c.provider,
          mode: c.mode,
          enabled: c.enabled,
          ...await probeProvider(c, createAdapter(c, config)),
        }))),
      );
      return true;
    }
    if (url.pathname === "/api/v2/metrics") {
      const events = [];
      for (const run of await listGraphRuns(root))
        if (!run.legacy)
          events.push(
            ...(await new RunStore(paths.root, run.runId).readAfter()),
          );
      const measurements = await collectRoutingHistory(root);
      json(
        res,
        200,
        aggregateUsage(events).map((row) => ({
          ...row,
          quality: measurements
            .filter(
              (m) =>
                m.connectionId === row.connectionId &&
                m.modelId === row.modelId,
            )
            .map((m) => ({
              ...m,
              lowerBound: wilsonLower(m.qualifiedSuccesses, m.attempts),
              dataStatus: m.attempts >= 20 ? "comparable" : "insufficient_data",
            })),
        })),
      );
      return true;
    }
    const parts = url.pathname.split("/");
    if (parts[3] !== "runs" || !parts[4]) {
      json(res, 404, { error: "Not found" });
      return true;
    }
    const store = new RunStore(paths.root, parts[4]);
    const revision = Number(url.searchParams.get("revision"));
    let rows = await store.readAfter();
    if (revision) {
      if (
        !rows.some(
          (e) =>
            e.type === "graph.revised" && e.payload.graph.revision === revision,
        )
      ) {
        json(res, 404, { error: "Revision not found" });
        return true;
      }
      const end = rows.findIndex(
        (e) =>
          e.type === "graph.revised" && e.payload.graph.revision > revision,
      );
      if (end >= 0) rows = rows.slice(0, end);
    }
    const state = replay(store.runId, rows);

    if (state.seq === 0) {
      json(res, 404, { error: "Run not found" });
      return true;
    }
    if (parts.length === 5) {
      json(res, 200, state);
      return true;
    }
    if (parts[5] === "graph") {
      const revision = Number(url.searchParams.get("revision"));
      if (revision) {
        const event = (await store.readAfter()).find(
          (e) =>
            e.type === "graph.revised" && e.payload.graph.revision === revision,
        );
        json(
          res,
          event ? 200 : 404,
          event?.type === "graph.revised"
            ? event.payload.graph
            : { error: "Revision not found" },
        );
      } else json(res, 200, await store.graph());
      return true;
    }
    if (parts[5] === "nodes") {
      const nodeId = parts[6]!;
      json(res, 200, {
        ...state.nodes[nodeId],
        events: rows.filter(
          (e) => "nodeId" in e.payload && e.payload.nodeId === nodeId,
        ),
      });
      return true;
    }
    if (parts[5] === "artifacts") {
      json(res, 200, await store.artifact(parts[6]!));
      return true;
    }
    if (parts[5] === "events") {
      let after = Number(
        req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0,
      );
      if (!Number.isSafeInteger(after) || after < 0) {
        json(res, 400, { error: "Invalid event cursor" });
        return true;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      let closed = false;
      let busy = false;
      const push = async () => {
        if (closed || busy) return;
        busy = true;
        try {
          for (const event of await store.readAfter(after)) {
            if (closed) break;
            after = event.seq;
            if (
              !res.write(
                `id: ${event.seq}\nevent: ralph\ndata: ${JSON.stringify(event)}\n\n`,
              )
            ) {
              res.end();
              closed = true;
              break;
            }
          }
        } catch {
          res.end();
          closed = true;
        } finally {
          busy = false;
        }
      };
      await push();
      const timer = setInterval(() => void push(), 300);
      req.on("close", () => {
        closed = true;
        clearInterval(timer);
      });
      return true;
    }
    if (parts[5] === "commands" && req.method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64_000)
          throw new RalphError("Request too large", "invalid_request", 4);
        chunks.push(chunk);
      }
      const command = JSON.parse(Buffer.concat(chunks).toString("utf8")) as
        | RunCommand
        | { commandId: string; expectedRevision: number; type: "resume" };
      const submitted = await submitCommand(store, command);
      if (command.type === "resume" && submitted.created) {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL("../cli.js", import.meta.url)),
            "__graph-resume",
            "--project",
            root,
            store.runId,
          ],
          { detached: true, stdio: "ignore", windowsHide: true },
        );
        child.unref();
      }
      json(res, 202, { accepted: true, commandId: command.commandId });
      return true;
    }
    json(res, 404, { error: "Not found" });
    return true;
  } catch (e) {
    json(
      res,
      e instanceof RalphError && e.code.includes("conflict") ? 409 : 400,
      { error: e instanceof Error ? e.message : String(e) },
    );
    return true;
  }
}

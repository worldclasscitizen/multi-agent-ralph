import { controlToken, handleGraphApi } from "./dashboard/api.js";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import { capacityForProject } from "./capacity.js";
import { gitBranch, gitStatus } from "./git.js";
import { registeredProjects } from "./registry.js";
import {
  activeRun,
  deleteRun,
  listRuns,
  loadConfig,
  loadContract,
  readEvents,
  requestStop,
  statePaths,
} from "./state.js";
import { atomicWrite, readJson, runCommand } from "./util.js";

const ASSETS = fileURLToPath(new URL("../assets/dashboard", import.meta.url));

async function readBody(
  request: import("node:http").IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (Buffer.concat(chunks).byteLength > 64_000)
    throw new Error("요청 크기 상한을 초과했습니다.");
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

export async function dashboardSnapshot(
  projectRoot: string,
  runId?: string,
): Promise<Record<string, unknown>> {
  const [runs, config, branch, status, numstat] = await Promise.all([
    listRuns(projectRoot),
    loadConfig(projectRoot),
    gitBranch(projectRoot),
    gitStatus(projectRoot),
    runCommand("git", ["diff", "--numstat", "HEAD", "--"], {
      cwd: projectRoot,
    }),
  ]);
  const selected = runId ? runs.find((run) => run.id === runId) : runs[0];
  let contract;
  let events: unknown[] = [];
  let usage: unknown[] = [];
  if (selected) {
    try {
      contract = await loadContract(projectRoot, selected.contractId);
    } catch {
      contract = undefined;
    }
    events = await readEvents(projectRoot, selected.id);
    const paths = await statePaths(projectRoot);
    try {
      usage = (
        await readFile(join(paths.runs, selected.id, "usage.jsonl"), "utf8")
      )
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      usage = [];
    }
  }
  const lineStats = Object.fromEntries(
    numstat.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        const [added, deleted, ...path] = line.split("\t");
        return path.length ? [[path.join("\t"), { added, deleted }]] : [];
      }),
  );
  return {
    projectRoot,
    branch,
    gitStatus: status,
    gitLineStats: lineStats,
    runs,
    selected,
    contract,
    events,
    usage,
    routes: config.routes,
  };
}

async function usageRows(
  projectRoot: string,
  runId?: string,
): Promise<unknown[]> {
  const paths = await statePaths(projectRoot);
  const selectedRuns = runId
    ? (await listRuns(projectRoot)).filter((run) => run.id === runId)
    : await listRuns(projectRoot);
  const rows: unknown[] = [];
  for (const run of selectedRuns) {
    try {
      rows.push(
        ...(await readFile(join(paths.runs, run.id, "usage.jsonl"), "utf8"))
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
    } catch {
      /* 이 run에는 구조화된 사용량이 없습니다. */
    }
  }
  return rows;
}

export async function startDashboard(
  projectRoot: string,
  options: { port?: number; all?: boolean } = {},
): Promise<{ server: Server; url: string }> {
  const port = options.port ?? 7331;
  const projects = options.all ? await registeredProjects() : [projectRoot];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "127.0.0.1"}`,
      );
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
        return json(response, 403, { error: "Invalid host" });
      if (request.headers.origin && request.headers.origin !== url.origin)
        return json(response, 403, { error: "Origin not allowed" });
      if (
        request.method !== "GET" &&
        request.headers["x-ralph-token"] !== controlToken
      )
        return json(response, 403, { error: "Control token required" });
      const requestedRoot =
        options.all && url.searchParams.get("project")
          ? url.searchParams.get("project")!
          : projectRoot;
      if (!projects.includes(requestedRoot))
        return json(response, 403, { error: "등록되지 않은 프로젝트입니다." });
      if (await handleGraphApi(request, response, url, requestedRoot)) return;
      if (request.method === "GET" && url.pathname === "/api/snapshot")
        return json(
          response,
          200,
          await dashboardSnapshot(
            requestedRoot,
            url.searchParams.get("runId") ?? undefined,
          ),
        );
      if (request.method === "GET" && url.pathname === "/api/projects")
        return json(response, 200, projects);
      if (request.method === "GET" && url.pathname === "/api/usage") {
        const scope = url.searchParams.get("scope") ?? "run";
        if (scope === "run")
          return json(
            response,
            200,
            await usageRows(
              requestedRoot,
              url.searchParams.get("runId") ?? undefined,
            ),
          );
        if (scope === "project")
          return json(response, 200, await usageRows(requestedRoot));
        if (scope === "all" && options.all) {
          const rows: unknown[] = [];
          for (const project of projects)
            rows.push(...(await usageRows(project)));
          return json(response, 200, rows);
        }
        return json(response, 400, {
          error: "지원하지 않거나 허용되지 않은 사용량 범위입니다.",
        });
      }
      if (request.method === "GET" && url.pathname === "/api/capacity")
        return json(
          response,
          200,
          await capacityForProject(
            requestedRoot,
            await loadConfig(requestedRoot),
            url.searchParams.get("refresh") === "1",
          ),
        );
      if (request.method === "GET" && url.pathname === "/api/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        let last = "";
        const push = async () => {
          const snapshot = JSON.stringify(
            await dashboardSnapshot(
              requestedRoot,
              url.searchParams.get("runId") ?? undefined,
            ),
          );
          if (snapshot !== last) {
            last = snapshot;
            response.write(`event: snapshot\ndata: ${snapshot}\n\n`);
          }
        };
        await push();
        const timer = setInterval(() => void push(), 1_000);
        request.on("close", () => clearInterval(timer));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/history/delete") {
        const body = (await readBody(request)) as { runIds?: string[] };
        for (const id of body.runIds ?? []) await deleteRun(requestedRoot, id);
        return json(response, 200, { deleted: body.runIds ?? [] });
      }
      if (request.method === "POST" && url.pathname === "/api/history/clear") {
        const runs = await listRuns(requestedRoot);
        const deleted = [];
        for (const run of runs.filter((item) => item.status !== "running")) {
          await deleteRun(requestedRoot, run.id);
          deleted.push(run.id);
        }
        return json(response, 200, { deleted });
      }
      if (request.method === "POST" && url.pathname === "/api/stop") {
        if (!(await activeRun(requestedRoot)))
          return json(response, 409, { error: "실행 중인 Ralph가 없습니다." });
        await requestStop(requestedRoot);
        return json(response, 200, { requested: true });
      }
      if (request.method === "POST" && url.pathname === "/api/operator-note") {
        const body = (await readBody(request)) as { note?: string };
        const paths = await statePaths(requestedRoot);
        await atomicWrite(
          join(paths.dashboard, "operator-note.md"),
          `${String(body.note ?? "").slice(0, 20_000)}\n`,
        );
        return json(response, 200, { saved: true });
      }
      const asset = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (
        !/^(index\.html|app\.js|elk\.bundled\.js|styles\.css|chunks\/[a-zA-Z0-9_-]+\.js)$/.test(
          asset,
        )
      )
        return json(response, 404, { error: "not found" });
      const path = join(ASSETS, asset);
      await stat(path);
      response.writeHead(200, {
        "Content-Type": asset.endsWith(".html")
          ? "text/html; charset=utf-8"
          : asset.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : "text/css; charset=utf-8",
      });
      createReadStream(path).pipe(response);
    } catch (error) {
      json(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;
  return { server, url: `http://127.0.0.1:${actualPort}/` };
}

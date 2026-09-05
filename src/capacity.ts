import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CapacitySnapshot, ProjectConfig } from "./types.js";
import { adapterMap } from "./providers/index.js";
import { ensureState } from "./state.js";
import { resolveExecutable, writeJson } from "./util.js";

interface RateLimitWindow {
  usedPercent: number;
  resetsAt?: number | null;
  windowDurationMins?: number | null;
}
interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
}

async function codexCapacity(): Promise<CapacitySnapshot> {
  const executable = await resolveExecutable("codex");
  return await new Promise((resolve) => {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_BASE_URL;
    const child = spawn(
      executable.command,
      [...executable.prefix, "app-server", "--stdio"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env },
    );
    let buffer = "";
    let settled = false;
    const finish = (value: CapacitySnapshot) => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve(value);
    };
    const timer = setTimeout(
      () =>
        finish({
          kind: "subscription",
          status: "unavailable",
          fetchedAt: new Date().toISOString(),
          source: "Codex App Server account/rateLimits/read",
          detail: "3초 안에 응답하지 않았습니다.",
        }),
      3_000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as {
            id?: number;
            result?: {
              rateLimits?: RateLimitSnapshot;
              rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
            };
          };
          if (message.id !== 2 || !message.result) continue;
          clearTimeout(timer);
          const snapshots = message.result.rateLimitsByLimitId
            ? Object.values(message.result.rateLimitsByLimitId)
            : message.result.rateLimits
              ? [message.result.rateLimits]
              : [];
          const windows = snapshots
            .flatMap((snapshot) => [
              snapshot.primary
                ? {
                    label: `${snapshot.limitName ?? snapshot.limitId ?? "Codex"} primary`,
                    remainingPercent: Math.max(
                      0,
                      100 - snapshot.primary.usedPercent,
                    ),
                    ...(snapshot.primary.resetsAt
                      ? {
                          resetsAt: new Date(
                            snapshot.primary.resetsAt * 1000,
                          ).toISOString(),
                        }
                      : {}),
                  }
                : undefined,
              snapshot.secondary
                ? {
                    label: `${snapshot.limitName ?? snapshot.limitId ?? "Codex"} secondary`,
                    remainingPercent: Math.max(
                      0,
                      100 - snapshot.secondary.usedPercent,
                    ),
                    ...(snapshot.secondary.resetsAt
                      ? {
                          resetsAt: new Date(
                            snapshot.secondary.resetsAt * 1000,
                          ).toISOString(),
                        }
                      : {}),
                  }
                : undefined,
            ])
            .filter((item): item is NonNullable<typeof item> => Boolean(item));
          finish({
            kind: "subscription",
            status: windows.length ? "exact" : "unavailable",
            ...(windows.length ? { windows } : {}),
            fetchedAt: new Date().toISOString(),
            source: "Codex App Server account/rateLimits/read",
          });
        } catch {
          // notifications and non-JSON lines are ignored
        }
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({
        kind: "subscription",
        status: "unavailable",
        fetchedAt: new Date().toISOString(),
        source: "Codex App Server account/rateLimits/read",
        detail: error.message,
      });
    });
    child.stdin.write(
      `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "ralph", title: "Ralph CLI", version: "0.3.0" }, capabilities: null } })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ id: 2, method: "account/rateLimits/read", params: null })}\n`,
    );
  });
}

function unsupportedSubscription(
  source: string,
  detail: string,
): CapacitySnapshot {
  return {
    kind: "subscription",
    status: "unavailable",
    fetchedAt: new Date().toISOString(),
    source,
    detail,
  };
}

export async function capacityForProject(
  projectRoot: string,
  config: ProjectConfig,
  refresh = false,
): Promise<Record<string, CapacitySnapshot>> {
  const paths = await ensureState(projectRoot);
  const cache = join(paths.dashboard, "capacity.json");
  if (!refresh) {
    try {
      const info = await stat(cache);
      if (Date.now() - info.mtimeMs < 5 * 60 * 1000)
        return JSON.parse(await readFile(cache, "utf8")) as Record<
          string,
          CapacitySnapshot
        >;
    } catch {
      /* refresh */
    }
  }
  const adapters = adapterMap(config);
  const output: Record<string, CapacitySnapshot> = {};
  for (const connection of config.connections.filter((item) => item.enabled)) {
    if (connection.adapter === "codex-builtin")
      output[connection.id] = await codexCapacity();
    else if (connection.adapter === "antigravity-builtin")
      output[connection.id] = unsupportedSubscription(
        "Antigravity /usage",
        "공식 /usage는 대화형 TUI이므로 자동 스크래핑하지 않습니다. Antigravity에서 /usage를 직접 실행해 주세요.",
      );
    else if (connection.adapter === "claude-code-builtin")
      output[connection.id] = unsupportedSubscription(
        "Claude Code",
        "정확한 구조화 잔여량 인터페이스가 확인되지 않았습니다.",
      );
    else if (connection.adapter === "gemini-cli-builtin")
      output[connection.id] = unsupportedSubscription(
        "Gemini CLI",
        "정확한 구조화 잔여량 인터페이스가 확인되지 않았습니다.",
      );
    else {
      const adapter = adapters.get(connection.id);
      output[connection.id] = adapter?.capacity
        ? await adapter.capacity()
        : {
            kind: "api_balance",
            status: "unavailable",
            fetchedAt: new Date().toISOString(),
            source: connection.id,
            detail: "공식 잔액 endpoint가 확인되지 않았습니다.",
          };
    }
  }
  await writeJson(cache, output);
  return output;
}

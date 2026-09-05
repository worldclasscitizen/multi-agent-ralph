import { resolveExecutable } from "../util.js";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRequest,
  AgentResult,
  AuthStatus,
  ModelDescriptor,
  ProviderAdapter,
  ProviderDetection,
} from "../types.js";
import { commandExists, runCommand } from "../util.js";
import { classifyProviderError, emptyResponseError } from "./errors.js";

abstract class CliAdapter implements ProviderAdapter {
  abstract id: string;
  readonly mode = "builtin" as const;
  abstract command: string;

  async detect(): Promise<ProviderDetection> {
    const executable = await commandExists(this.command);
    if (!executable) return { installed: false };
    const result = await runCommand(this.command, ["--version"], {
      timeoutMs: 15000,
    });
    return {
      installed: true,
      executable,
      ...(result.stdout.trim() ? { version: result.stdout.trim() } : {}),
    };
  }

  abstract authStatus(): Promise<AuthStatus>;
  abstract listModels(): Promise<ModelDescriptor[]>;
  abstract invoke(
    request: AgentRequest,
    signal: AbortSignal,
  ): Promise<AgentResult>;

  protected resultFrom(
    command: string,
    exitCode: number,
    stderr: string,
    sessionId?: string,
  ): AgentResult {
    if (exitCode !== 0)
      return {
        text: "",
        exitCode,
        ...(sessionId ? { sessionId } : {}),
        error: classifyProviderError({ stderr: stderr || command }),
      };
    if (!command.trim())
      return {
        text: "",
        exitCode: 74,
        ...(sessionId ? { sessionId } : {}),
        error: emptyResponseError(this.id),
      };
    return {
      text: command.trim(),
      exitCode: 0,
      ...(sessionId ? { sessionId } : {}),
    };
  }
}

function cleanClaudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ])
    delete env[key];
  return env;
}

function cleanCodexEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL"]) delete env[key];
  return env;
}

function cleanGoogleBuiltinEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_USE_VERTEXAI",
  ])
    delete env[key];
  return env;
}

export class CodexBuiltinAdapter extends CliAdapter {
  id = "codex-builtin";
  command = "codex";

  async authStatus(): Promise<AuthStatus> {
    const result = await runCommand("codex", ["login", "status"], {
      env: cleanCodexEnv(),
      timeoutMs: 15000,
    });
    return result.exitCode === 0
      ? {
          status: "authenticated",
          method: "builtin",
          detail: result.stdout.trim() || result.stderr.trim(),
        }
      : {
          status: "unauthenticated",
          method: "builtin",
          detail: result.stderr.trim(),
        };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const executable = await resolveExecutable("codex");
    return await new Promise((resolve) => {
      const child = spawn(
        executable.command,
        [...executable.prefix, "app-server", "--stdio"],
        {
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
          env: cleanCodexEnv(),
        },
      );
      let buffer = "";
      let settled = false;
      const finish = (models: ModelDescriptor[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolve(models);
      };
      const timer = setTimeout(() => finish([]), 3_000);
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const message = JSON.parse(line) as {
              id?: number;
              result?: {
                data?: Array<{
                  id?: string;
                  model?: string;
                  displayName?: string;
                  defaultReasoningEffort?: string;
                }>;
              };
            };
            if (message.id !== 2 || !message.result?.data) continue;
            finish(
              message.result.data.flatMap((item) => {
                const modelId = item.model ?? item.id;
                return modelId
                  ? [
                      {
                        connectionId: "openai:codex-login",
                        provider: "openai",
                        modelId,
                        displayName: item.displayName ?? modelId,
                        mode: "builtin" as const,
                        reasoningEffort: item.defaultReasoningEffort,
                      },
                    ]
                  : [];
              }),
            );
          } catch {
            /* notifications are ignored */
          }
        }
      });
      child.on("error", () => finish([]));
      child.stdin.write(
        `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "ralph", title: "Ralph CLI", version: "0.3.0" }, capabilities: null } })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({ id: 2, method: "model/list", params: { limit: 100 } })}\n`,
      );
    });
  }

  async invoke(
    request: AgentRequest,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const temp = await mkdtemp(join(tmpdir(), "ralph-codex-"));
    const output = join(temp, "last-message.txt");
    const persistent =
      request.role === "worker" || request.role === "metaPrompter";
    const common = [
      "--model",
      request.model.modelId,
      "-c",
      'model_provider="openai"',
      "-c",
      `model_reasoning_effort=\"${request.model.reasoningEffort ?? "high"}\"`,
      "--json",
      "--color",
      "never",
      "--output-last-message",
      output,
    ];
    const args = request.sessionId
      ? ["exec", "resume", ...common, request.sessionId, "-"]
      : [
          "exec",
          ...common,
          "--sandbox",
          request.role === "worker" ? "workspace-write" : "read-only",
          "--cd",
          request.projectRoot,
          ...(persistent ? [] : ["--ephemeral"]),
          "-",
        ];
    const result = await runCommand("codex", args, {
      cwd: request.projectRoot,
      env: cleanCodexEnv(),
      input: request.prompt,
      signal,
      timeoutMs: 900_000,
    });
    let text = "";
    try {
      text = await readFile(output, "utf8");
    } catch {
      text = "";
    }
    const events = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    const started = events.find((event) => event.type === "thread.started");
    const sessionId =
      typeof started?.thread_id === "string"
        ? started.thread_id
        : request.sessionId;
    const usages = events
      .filter((event) => event.type === "turn.completed")
      .map((event) => event.usage as Record<string, number> | undefined)
      .filter(Boolean);
    const usage = usages.length
      ? {
          inputTokens: usages.reduce(
            (sum, item) => sum + (item?.input_tokens ?? 0),
            0,
          ),
          outputTokens: usages.reduce(
            (sum, item) => sum + (item?.output_tokens ?? 0),
            0,
          ),
          cachedTokens: usages.reduce(
            (sum, item) => sum + (item?.cached_input_tokens ?? 0),
            0,
          ),
          reasoningTokens: usages.reduce(
            (sum, item) => sum + (item?.reasoning_output_tokens ?? 0),
            0,
          ),
          totalTokens: usages.reduce(
            (sum, item) =>
              sum +
              (item?.total_tokens ??
                (item?.input_tokens ?? 0) + (item?.output_tokens ?? 0)),
            0,
          ),
        }
      : undefined;
    const normalized = this.resultFrom(
      text,
      result.exitCode,
      result.stderr,
      sessionId,
    );
    return {
      ...normalized,
      ...(usage ? { usage } : {}),
      rawModelId: request.model.modelId,
    };
  }
}

export class ClaudeBuiltinAdapter extends CliAdapter {
  id = "claude-code-builtin";
  command = "claude";

  async authStatus(): Promise<AuthStatus> {
    const result = await runCommand(
      "claude",
      ["--setting-sources", "", "auth", "status"],
      { env: cleanClaudeEnv(), timeoutMs: 15000 },
    );
    try {
      const data = JSON.parse(result.stdout) as {
        loggedIn?: boolean;
        authMethod?: string;
        email?: string;
      };
      return data.loggedIn
        ? {
            status: "authenticated",
            method: "builtin",
            ...(data.email ? { accountLabel: data.email } : {}),
            detail: data.authMethod,
          }
        : { status: "unauthenticated", method: "builtin" };
    } catch {
      return {
        status: result.exitCode === 0 ? "unknown" : "unauthenticated",
        method: "builtin",
        detail: result.stderr.trim(),
      };
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }

  async invoke(
    request: AgentRequest,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const persistent =
      request.role === "worker" || request.role === "metaPrompter";
    const args = [
      "--print",
      "--model",
      request.model.modelId,
      "--effort",
      request.model.reasoningEffort ?? "high",
      "--permission-mode",
      request.role === "worker" ? "acceptEdits" : "plan",
      "--output-format",
      "json",
      "--no-chrome",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--tools",
      request.role === "worker" ? "default" : "",
      ...(request.sessionId
        ? ["--resume", request.sessionId]
        : persistent
          ? []
          : ["--no-session-persistence"]),
    ];
    const result = await runCommand("claude", args, {
      cwd: request.projectRoot,
      env: cleanClaudeEnv(),
      input: request.prompt,
      signal,
      timeoutMs: 900_000,
    });
    try {
      const data = JSON.parse(result.stdout) as Record<string, unknown>;
      const text = String(
        data.result ??
          data.response ??
          (Array.isArray(data.errors) ? data.errors.join("\n") : ""),
      );
      const sessionId =
        typeof data.session_id === "string"
          ? data.session_id
          : request.sessionId;
      const rawUsage = data.usage as Record<string, number> | undefined;
      const normalized = this.resultFrom(
        text,
        result.exitCode,
        result.stderr,
        sessionId,
      );
      return {
        ...normalized,
        ...(rawUsage
          ? {
              usage: {
                inputTokens: rawUsage.input_tokens,
                outputTokens: rawUsage.output_tokens,
                cachedTokens: rawUsage.cache_read_input_tokens,
                totalTokens:
                  (rawUsage.input_tokens ?? 0) + (rawUsage.output_tokens ?? 0),
              },
            }
          : {}),
        rawModelId: request.model.modelId,
      };
    } catch {
      return {
        text: "",
        exitCode: result.exitCode || 4,
        error: classifyProviderError({
          stderr: `${result.stderr}\n${result.stdout}`,
          explicitKind: result.exitCode === 0 ? "schema_error" : undefined,
        }),
      };
    }
  }
}

export class AntigravityBuiltinAdapter extends CliAdapter {
  id = "antigravity-builtin";
  command = "agy";

  async authStatus(): Promise<AuthStatus> {
    const detected = await this.detect();
    return detected.installed
      ? {
          status: "unknown",
          method: "builtin",
          detail:
            "agy는 구조화된 로그인 상태 명령을 제공하지 않아 실제 호출 시 확인합니다.",
        }
      : { status: "unavailable", method: "builtin" };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const result = await runCommand("agy", ["models"], {
      env: cleanGoogleBuiltinEnv(),
      timeoutMs: 4_000,
    });
    if (result.exitCode !== 0) return [];
    return result.stdout.split(/\r?\n/).flatMap((line) => {
      const [modelId, displayName] = line.split("\t");
      return modelId && displayName
        ? [
            {
              connectionId: "google:antigravity-login",
              provider: "google",
              modelId,
              displayName,
              mode: "builtin" as const,
            },
          ]
        : [];
    });
  }

  async invoke(
    request: AgentRequest,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const input = `${JSON.stringify({ event: "user", message: { content: request.prompt } })}\n`;
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      request.model.modelId,
      "--mode",
      request.role === "worker" ? "accept-edits" : "plan",
      "--effort",
      request.model.reasoningEffort ?? "high",
      "--print-timeout",
      "10m",
      ...(request.sessionId ? ["--conversation", request.sessionId] : []),
    ];
    const result = await runCommand("agy", args, {
      cwd: request.projectRoot,
      env: cleanGoogleBuiltinEnv(),
      input,
      signal,
      timeoutMs: 900_000,
    });
    const rows = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    const event = [...rows].reverse().find((row) => row.event === "result");
    if (!event)
      return {
        text: "",
        exitCode: result.exitCode || 4,
        error: classifyProviderError({
          stderr: `${result.stderr}\nAntigravity result event가 없습니다.`,
          explicitKind: result.exitCode === 0 ? "schema_error" : undefined,
        }),
      };
    const data = event?.result as Record<string, unknown> | undefined;
    const status = String(data?.status ?? "ERROR");
    const text = typeof data?.response === "string" ? data.response : "";
    const sessionId =
      typeof data?.conversation_id === "string"
        ? data.conversation_id
        : typeof data?.conversationId === "string"
          ? data.conversationId
          : request.sessionId;
    if (result.exitCode !== 0 || status !== "SUCCESS")
      return {
        text: "",
        exitCode: result.exitCode || 4,
        ...(sessionId ? { sessionId } : {}),
        error: classifyProviderError({
          stderr: `${result.stderr}\n${String(data?.error ?? "")}`,
        }),
      };
    return {
      ...this.resultFrom(text, 0, result.stderr, sessionId),
      rawModelId: request.model.modelId,
    };
  }
}

export class GeminiCliBuiltinAdapter extends CliAdapter {
  id = "gemini-cli-builtin";
  command = "gemini";

  async authStatus(): Promise<AuthStatus> {
    const detected = await this.detect();
    return detected.installed
      ? {
          status: "unknown",
          method: "builtin",
          detail:
            "Gemini CLI는 구조화된 로그인 상태 명령을 제공하지 않아 실제 호출 시 확인합니다.",
        }
      : { status: "unavailable", method: "builtin" };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }

  async invoke(
    request: AgentRequest,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const args = [
      "--model",
      request.model.modelId,
      "--approval-mode",
      request.role === "worker" ? "auto_edit" : "plan",
      "--output-format",
      "json",
      ...(request.sessionId ? ["--resume", request.sessionId] : []),
      "--prompt",
      request.prompt,
    ];
    const result = await runCommand("gemini", args, {
      cwd: request.projectRoot,
      env: cleanGoogleBuiltinEnv(),
      signal,
      timeoutMs: 900_000,
    });
    try {
      const data = JSON.parse(result.stdout) as Record<string, unknown>;
      const text = String(data.response ?? data.result ?? data.output ?? "");
      const usageMeta = data.usageMetadata as
        Record<string, number> | undefined;
      const stats = data.stats as
        | {
            models?: Record<
              string,
              {
                tokens?: {
                  input?: number;
                  prompt?: number;
                  candidates?: number;
                  total?: number;
                  cached?: number;
                  thoughts?: number;
                };
              }
            >;
          }
        | undefined;
      const modelStats = Object.values(stats?.models ?? {});
      const usage = usageMeta
        ? {
            inputTokens: usageMeta.promptTokenCount,
            outputTokens: usageMeta.candidatesTokenCount,
            totalTokens: usageMeta.totalTokenCount,
          }
        : modelStats.length
          ? {
              inputTokens: modelStats.reduce(
                (sum, item) =>
                  sum + (item.tokens?.input ?? item.tokens?.prompt ?? 0),
                0,
              ),
              outputTokens: modelStats.reduce(
                (sum, item) => sum + (item.tokens?.candidates ?? 0),
                0,
              ),
              cachedTokens: modelStats.reduce(
                (sum, item) => sum + (item.tokens?.cached ?? 0),
                0,
              ),
              reasoningTokens: modelStats.reduce(
                (sum, item) => sum + (item.tokens?.thoughts ?? 0),
                0,
              ),
              totalTokens: modelStats.reduce(
                (sum, item) => sum + (item.tokens?.total ?? 0),
                0,
              ),
            }
          : undefined;
      const sessionId =
        typeof data.session_id === "string"
          ? data.session_id
          : request.sessionId;
      const normalized = this.resultFrom(
        text,
        result.exitCode,
        result.stderr,
        sessionId,
      );
      return {
        ...normalized,
        ...(usage ? { usage, usageCumulative: Boolean(stats) } : {}),
        rawModelId:
          Object.keys(stats?.models ?? {})[0] ?? request.model.modelId,
      };
    } catch {
      return {
        text: "",
        exitCode: result.exitCode || 4,
        error: classifyProviderError({
          stderr: `${result.stderr}\nGemini CLI JSON 출력을 해석하지 못했습니다.`,
          explicitKind: result.exitCode === 0 ? "schema_error" : undefined,
        }),
      };
    }
  }
}

import type {
  AgentRequest,
  AgentResult,
  AuthStatus,
  CapacitySnapshot,
  ConnectionConfig,
  ModelDescriptor,
  ProviderAdapter,
} from "../types.js";
import { providerToolDefinitions, WorkspaceTools } from "../tools.js";
import { getCredential } from "../credentials.js";
import {
  retryAfterMs,
  classifyProviderError,
  emptyResponseError,
} from "./errors.js";
import { runCommand } from "../util.js";

interface ChatMessage {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
}
interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly mode = "api" as const;
  readonly id: string;

  constructor(
    private readonly connection: ConnectionConfig,
    private readonly verifierCommands: string[],
  ) {
    this.id = connection.adapter;
  }

  async detect() {
    return { installed: true, detail: this.connection.baseUrl };
  }

  async authStatus(): Promise<AuthStatus> {
    const key = await getCredential(
      this.connection.id,
      this.connection.apiKeyEnv,
    );
    return key
      ? { status: "authenticated", method: "api_key" }
      : {
          status: "unauthenticated",
          method: "api_key",
          detail: `${this.connection.apiKeyEnv ?? "API key"}가 필요합니다.`,
        };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const key = await getCredential(
      this.connection.id,
      this.connection.apiKeyEnv,
    );
    if (!key) return [];
    try {
      const response = await fetch(
        `${this.connection.baseUrl?.replace(/\/$/, "")}/models`,
        {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(3_000),
        },
      );
      if (!response.ok) return [];
      const body = (await response.json()) as { data?: Array<{ id?: string }> };
      return (body.data ?? []).flatMap((item) =>
        item.id
          ? [
              {
                connectionId: this.connection.id,
                provider: this.connection.provider,
                modelId: item.id,
                displayName: item.id,
                mode: "api" as const,
              },
            ]
          : [],
      );
    } catch {
      return [];
    }
  }

  async invoke(
    request: AgentRequest,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const key = await getCredential(
      this.connection.id,
      this.connection.apiKeyEnv,
    );
    if (!key)
      return {
        text: "",
        exitCode: 77,
        error: classifyProviderError({
          message: `${this.connection.apiKeyEnv ?? "API key"}가 없습니다.`,
          explicitKind: "authentication",
        }),
      };
    const tools = new WorkspaceTools(
      request.projectRoot,
      [],
      160,
      {
        ...request,
        writePaths:
          request.role === "worker" ? (request.writePaths ?? ["**"]) : [],
      },
      signal,
    );
    const messages: ChatMessage[] = [{ role: "user", content: request.prompt }];
    let measured = true;
    let aggregate = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    };
    try {
      for (let turn = 0; turn < (tools ? 48 : 1); turn += 1) {
        const response = await fetch(
          `${this.connection.baseUrl?.replace(/\/$/, "")}/chat/completions`,
          {
            method: "POST",
            signal,
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: request.model.modelId,
              messages,
              reasoning_effort: request.model.reasoningEffort,
              thinking: { type: "enabled" },
              stream: false,
              ...(tools
                ? {
                    tools: providerToolDefinitions(request.role).map(
                      (tool) => ({
                        type: "function",
                        function: {
                          name: tool.name,
                          description: tool.description,
                          parameters: tool.inputSchema,
                        },
                      }),
                    ),
                    tool_choice: "auto",
                  }
                : {}),
            }),
          },
        );
        const bodyText = await response.text();
        if (!response.ok) {
          let message = bodyText;
          try {
            const body = JSON.parse(bodyText) as {
              error?: { message?: string };
              message?: string;
            };
            message = body.error?.message ?? body.message ?? bodyText;
          } catch {
            /* use text */
          }
          return {
            text: "",
            exitCode: response.status,
            error: classifyProviderError({
              statusCode: response.status,
              message,
              retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
            }),
          };
        }
        const body = JSON.parse(bodyText) as {
          choices?: Array<{ message?: ChatMessage }>;
          usage?: Record<string, number>;
          model?: string;
        };
        const message = body.choices?.[0]?.message;
        if (!message)
          return {
            text: "",
            exitCode: 4,
            error: classifyProviderError({
              message: "choices[0].message가 없습니다.",
              explicitKind: "schema_error",
            }),
          };
        const usage = body.usage ?? {};
        measured &&=
          typeof (usage.prompt_tokens ?? usage.input_tokens) === "number" &&
          typeof (usage.completion_tokens ?? usage.output_tokens) === "number";
        aggregate.inputTokens += usage.prompt_tokens ?? usage.input_tokens ?? 0;
        aggregate.outputTokens +=
          usage.completion_tokens ?? usage.output_tokens ?? 0;
        aggregate.cachedTokens +=
          usage.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
        aggregate.reasoningTokens += usage.reasoning_tokens ?? 0;
        aggregate.totalTokens += usage.total_tokens ?? 0;
        if (message.tool_calls?.length && tools) {
          messages.push(message);
          for (const call of message.tool_calls) {
            let result: Record<string, unknown>;
            try {
              const args = JSON.parse(
                call.function.arguments || "{}",
              ) as Record<string, unknown>;
              result = await tools.execute(call.function.name, args);
            } catch (error) {
              result = {
                error: error instanceof Error ? error.message : String(error),
              };
            }
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(result),
            });
          }
          continue;
        }
        const text = message.content ?? "";
        if (!text.trim())
          return { text: "", exitCode: 74, error: emptyResponseError(this.id) };
        return {
          text,
          exitCode: 0,
          ...(measured ? { usage: aggregate } : {}),
          rawModelId: body.model ?? request.model.modelId,
        };
      }

      return {
        text: "",
        exitCode: 4,
        error: classifyProviderError({
          message: "API Worker가 최대 tool turn을 초과했습니다.",
          explicitKind: "invalid_request",
        }),
      };
    } catch (error) {
      return {
        text: "",
        exitCode: 1,
        error: classifyProviderError({
          message: error instanceof Error ? error.message : String(error),
          explicitKind:
            error instanceof DOMException && error.name === "AbortError"
              ? "timeout"
              : undefined,
        }),
      };
    }
  }

  async capacity(): Promise<CapacitySnapshot> {
    if (this.connection.adapter !== "deepseek-api")
      return {
        kind: "api_balance",
        status: "unavailable",
        fetchedAt: new Date().toISOString(),
        source: this.id,
        detail: "공식 잔액 조회 endpoint가 확인되지 않았습니다.",
      };
    const key = await getCredential(
      this.connection.id,
      this.connection.apiKeyEnv,
    );
    if (!key)
      return {
        kind: "api_balance",
        status: "auth_required",
        fetchedAt: new Date().toISOString(),
        source: "DeepSeek /user/balance",
      };
    try {
      const response = await fetch(
        `${this.connection.baseUrl?.replace(/\/$/, "")}/user/balance`,
        {
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: "application/json",
          },
        },
      );
      if (!response.ok)
        return {
          kind: "api_balance",
          status: response.status === 401 ? "auth_required" : "unavailable",
          fetchedAt: new Date().toISOString(),
          source: "DeepSeek /user/balance",
          detail: `HTTP ${response.status}`,
        };
      const body = (await response.json()) as {
        balance_infos?: Array<{
          currency: string;
          total_balance: string;
          granted_balance?: string;
          topped_up_balance?: string;
        }>;
      };
      return {
        kind: "api_balance",
        status: "exact",
        balances: (body.balance_infos ?? []).map((item) => ({
          currency: item.currency,
          total: item.total_balance,
          ...(item.granted_balance ? { granted: item.granted_balance } : {}),
          ...(item.topped_up_balance
            ? { toppedUp: item.topped_up_balance }
            : {}),
        })),
        fetchedAt: new Date().toISOString(),
        source: "DeepSeek /user/balance",
      };
    } catch (error) {
      return {
        kind: "api_balance",
        status: "unavailable",
        fetchedAt: new Date().toISOString(),
        source: "DeepSeek /user/balance",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export class GenericProcessAdapter implements ProviderAdapter {
  readonly mode = "process" as const;
  readonly id = "generic-process";
  constructor(private readonly connection: ConnectionConfig) {}
  async detect() {
    return {
      installed: Boolean(this.connection.command?.length),
      detail: this.connection.command?.[0],
    };
  }
  async authStatus(): Promise<AuthStatus> {
    return {
      status: this.connection.command?.length ? "unknown" : "unavailable",
      method: "process",
    };
  }
  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }
  async invoke(
    request: AgentRequest,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const command = this.connection.command;
    if (!command?.length)
      return {
        text: "",
        exitCode: 69,
        error: classifyProviderError({
          message: "generic-process 명령이 등록되지 않았습니다.",
          explicitKind: "unavailable",
        }),
      };
    const result = await runCommand(command[0]!, command.slice(1), {
      cwd: request.projectRoot,
      input: `${JSON.stringify(request)}\n`,
      signal,
      timeoutMs: 900_000,
    });
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    let parsed: AgentResult | undefined;
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as AgentResult & {
          type?: string;
          result?: AgentResult;
        };
        parsed = row.result ?? row;
      } catch {
        // NDJSON progress events may be followed by the final AgentResult.
      }
    }
    if (result.exitCode === 0 && parsed?.exitCode === 0 && parsed.text?.trim())
      return parsed;
    if (result.exitCode === 0 && parsed?.error)
      return {
        ...parsed,
        text: parsed.text ?? "",
        exitCode: parsed.exitCode || 1,
      };
    if (result.exitCode === 0 && parsed && parsed.exitCode !== 0)
      return {
        ...parsed,
        text: parsed.text ?? "",
        error:
          parsed.error ??
          classifyProviderError({
            stderr: result.stderr,
            explicitKind:
              parsed.exitCode === 75
                ? "server_error"
                : parsed.exitCode === 77
                  ? "authentication"
                  : undefined,
          }),
      };
    if (result.exitCode === 75)
      return {
        text: "",
        exitCode: 75,
        error: classifyProviderError({
          stderr: result.stderr,
          explicitKind: "server_error",
        }),
      };
    if (result.exitCode === 77)
      return {
        text: "",
        exitCode: 77,
        error: classifyProviderError({
          stderr: result.stderr,
          explicitKind: "authentication",
        }),
      };
    if (result.exitCode === 0)
      return { text: "", exitCode: 74, error: emptyResponseError(this.id) };
    return {
      text: "",
      exitCode: result.exitCode,
      error: classifyProviderError({ stderr: result.stderr }),
    };
  }
}

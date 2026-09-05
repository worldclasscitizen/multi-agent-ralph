import type {
  AgentRequest,
  AgentResult,
  AuthStatus,
  ConnectionConfig,
  ModelDescriptor,
  ProviderAdapter,
} from "../types.js";
import { getCredential } from "../credentials.js";
import { providerToolDefinitions, WorkspaceTools } from "../tools.js";
import {
  retryAfterMs,
  classifyProviderError,
  emptyResponseError,
} from "./errors.js";

abstract class NativeApiAdapter implements ProviderAdapter {
  readonly mode = "api" as const;
  abstract id: string;
  constructor(
    protected readonly connection: ConnectionConfig,
    protected readonly verifierCommands: string[],
  ) {}
  async detect() {
    return {
      installed: true,
      ...(this.connection.baseUrl ? { detail: this.connection.baseUrl } : {}),
    };
  }
  async authStatus(): Promise<AuthStatus> {
    return (await getCredential(this.connection.id, this.connection.apiKeyEnv))
      ? { status: "authenticated", method: "api_key" }
      : {
          status: "unauthenticated",
          method: "api_key",
          detail: `${this.connection.apiKeyEnv ?? "API key"}가 필요합니다.`,
        };
  }
  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }
  abstract invoke(
    request: AgentRequest,
    signal: AbortSignal,
  ): Promise<AgentResult>;
  protected async key(): Promise<string | undefined> {
    return await getCredential(this.connection.id, this.connection.apiKeyEnv);
  }
  protected async json(response: Response): Promise<Record<string, unknown>> {
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        const body = JSON.parse(text) as {
          error?: { message?: string };
          message?: string;
        };
        message = body.error?.message ?? body.message ?? text;
      } catch {
        /* use raw */
      }
      throw Object.assign(new Error(message), {
        statusCode: response.status,
        retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
      });
    }
    return JSON.parse(text) as Record<string, unknown>;
  }
  protected failed(error: unknown): AgentResult {
    const row = error as Error & { statusCode?: number; retryAfterMs?: number };
    return {
      text: "",
      exitCode: row.statusCode ?? 1,
      error: classifyProviderError({
        statusCode: row.statusCode,
        retryAfterMs: row.retryAfterMs,
        message: row.message,
        explicitKind: row.name === "AbortError" ? "timeout" : undefined,
      }),
    };
  }
}

export class OpenAIResponsesAdapter extends NativeApiAdapter {
  id = "openai-api";
  async listModels(): Promise<ModelDescriptor[]> {
    const key = await this.key();
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
    const key = await this.key();
    if (!key)
      return this.failed(
        Object.assign(new Error("OpenAI API key가 없습니다."), {
          statusCode: 401,
        }),
      );
    const harness = new WorkspaceTools(
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
    let previousResponseId: string | undefined = request.sessionId;
    let input: unknown = request.prompt;
    let measured = true;
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    };
    try {
      for (let turn = 0; turn < (harness ? 48 : 1); turn += 1) {
        const response = await fetch(
          `${this.connection.baseUrl?.replace(/\/$/, "")}/responses`,
          {
            method: "POST",
            signal,
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: request.model.modelId,
              input,
              reasoning: { effort: request.model.reasoningEffort },
              ...(previousResponseId
                ? { previous_response_id: previousResponseId }
                : {}),
              ...(harness
                ? {
                    tools: providerToolDefinitions(request.role).map(
                      (tool) => ({
                        type: "function",
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.inputSchema,
                        strict: true,
                      }),
                    ),
                  }
                : {}),
            }),
          },
        );
        const body = await this.json(response);
        previousResponseId = String(body.id ?? previousResponseId ?? "");
        const rawUsage = body.usage as Record<string, unknown> | undefined;
        measured &&=
          typeof rawUsage?.input_tokens === "number" &&
          typeof rawUsage?.output_tokens === "number";
        const inputDetails = rawUsage?.input_tokens_details as
          Record<string, number> | undefined;
        const outputDetails = rawUsage?.output_tokens_details as
          Record<string, number> | undefined;
        usage.inputTokens += Number(rawUsage?.input_tokens ?? 0);
        usage.outputTokens += Number(rawUsage?.output_tokens ?? 0);
        usage.cachedTokens += Number(inputDetails?.cached_tokens ?? 0);
        usage.reasoningTokens += Number(outputDetails?.reasoning_tokens ?? 0);
        usage.totalTokens += Number(rawUsage?.total_tokens ?? 0);
        const items = Array.isArray(body.output)
          ? (body.output as Array<Record<string, unknown>>)
          : [];
        const calls = items.filter((item) => item.type === "function_call");
        if (calls.length && harness) {
          const outputs = [];
          for (const call of calls) {
            let result: Record<string, unknown>;
            try {
              result = await harness.execute(
                String(call.name),
                JSON.parse(String(call.arguments ?? "{}")) as Record<
                  string,
                  unknown
                >,
              );
            } catch (error) {
              result = {
                error: error instanceof Error ? error.message : String(error),
              };
            }
            outputs.push({
              type: "function_call_output",
              call_id: call.call_id,
              output: JSON.stringify(result),
            });
          }
          input = outputs;
          continue;
        }
        const text =
          typeof body.output_text === "string"
            ? body.output_text
            : items
                .flatMap((item) =>
                  Array.isArray(item.content)
                    ? (item.content as Array<Record<string, unknown>>)
                    : [],
                )
                .filter((item) => item.type === "output_text")
                .map((item) => String(item.text ?? ""))
                .join("\n");
        if (!text.trim())
          return { text: "", exitCode: 74, error: emptyResponseError(this.id) };
        return {
          text,
          exitCode: 0,
          ...(previousResponseId ? { sessionId: previousResponseId } : {}),
          ...(measured ? { usage } : {}),
          rawModelId: String(body.model ?? request.model.modelId),
        };
      }
      return this.failed(
        new Error("OpenAI Worker tool turn 상한을 초과했습니다."),
      );
    } catch (error) {
      return this.failed(error);
    }
  }
}

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}
export class AnthropicMessagesAdapter extends NativeApiAdapter {
  id = "anthropic-api";
  async listModels(): Promise<ModelDescriptor[]> {
    const key = await this.key();
    if (!key) return [];
    try {
      const response = await fetch(
        `${this.connection.baseUrl?.replace(/\/$/, "")}/v1/models`,
        {
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
          signal: AbortSignal.timeout(3_000),
        },
      );
      if (!response.ok) return [];
      const body = (await response.json()) as {
        data?: Array<{ id?: string; display_name?: string }>;
      };
      return (body.data ?? []).flatMap((item) =>
        item.id
          ? [
              {
                connectionId: this.connection.id,
                provider: this.connection.provider,
                modelId: item.id,
                displayName: item.display_name ?? item.id,
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
    const key = await this.key();
    if (!key)
      return this.failed(
        Object.assign(new Error("Anthropic API key가 없습니다."), {
          statusCode: 401,
        }),
      );
    const harness = new WorkspaceTools(
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
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: request.prompt },
    ];
    let measured = true;
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
    };
    try {
      for (let turn = 0; turn < (harness ? 48 : 1); turn += 1) {
        const response = await fetch(
          `${this.connection.baseUrl?.replace(/\/$/, "")}/v1/messages`,
          {
            method: "POST",
            signal,
            headers: {
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: request.model.modelId,
              max_tokens: ["xhigh", "max"].includes(
                request.model.reasoningEffort ?? "",
              )
                ? 65536
                : 32768,
              messages,
              ...(request.model.modelId === "claude-fable-5"
                ? {}
                : { thinking: { type: "adaptive" } }),
              output_config: { effort: request.model.reasoningEffort },
              ...(harness
                ? {
                    tools: providerToolDefinitions(request.role).map(
                      (tool) => ({
                        name: tool.name,
                        description: tool.description,
                        input_schema: tool.inputSchema,
                      }),
                    ),
                  }
                : {}),
            }),
          },
        );
        const body = await this.json(response);
        const raw = body.usage as Record<string, number> | undefined;
        measured &&=
          typeof raw?.input_tokens === "number" &&
          typeof raw?.output_tokens === "number";
        usage.inputTokens += raw?.input_tokens ?? 0;
        usage.outputTokens += raw?.output_tokens ?? 0;
        usage.cachedTokens +=
          (raw?.cache_read_input_tokens ?? 0) +
          (raw?.cache_creation_input_tokens ?? 0);
        usage.totalTokens += raw?.input_tokens ?? 0;
        usage.totalTokens += raw?.output_tokens ?? 0;
        const content = Array.isArray(body.content)
          ? (body.content as AnthropicBlock[])
          : [];
        const calls = content.filter((item) => item.type === "tool_use");
        if (calls.length && harness) {
          messages.push({ role: "assistant", content });
          const results = [];
          for (const call of calls) {
            let result;
            try {
              result = await harness.execute(
                String(call.name),
                call.input ?? {},
              );
            } catch (error) {
              result = {
                error: error instanceof Error ? error.message : String(error),
              };
            }
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: JSON.stringify(result),
            });
          }
          messages.push({ role: "user", content: results });
          continue;
        }
        const text = content
          .filter((item) => item.type === "text")
          .map((item) => item.text ?? "")
          .join("\n");
        if (!text.trim())
          return { text: "", exitCode: 74, error: emptyResponseError(this.id) };
        return {
          text,
          exitCode: 0,
          ...(measured ? { usage } : {}),
          rawModelId: String(body.model ?? request.model.modelId),
        };
      }
      return this.failed(
        new Error("Anthropic Worker tool turn 상한을 초과했습니다."),
      );
    } catch (error) {
      return this.failed(error);
    }
  }
}

interface GeminiPart {
  thought?: boolean;
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
}
export class GeminiApiAdapter extends NativeApiAdapter {
  id = "gemini-api";
  async listModels(): Promise<ModelDescriptor[]> {
    const key = await this.key();
    if (!key) return [];
    try {
      const response = await fetch(
        `${this.connection.baseUrl?.replace(/\/$/, "")}/models?key=${encodeURIComponent(key)}`,
        { signal: AbortSignal.timeout(3_000) },
      );
      if (!response.ok) return [];
      const body = (await response.json()) as {
        models?: Array<{ name?: string; displayName?: string }>;
      };
      return (body.models ?? []).flatMap((item) => {
        const id = item.name?.replace(/^models\//, "");
        return id
          ? [
              {
                connectionId: this.connection.id,
                provider: this.connection.provider,
                modelId: id,
                displayName: item.displayName ?? id,
                mode: "api" as const,
              },
            ]
          : [];
      });
    } catch {
      return [];
    }
  }
  async invoke(
    request: AgentRequest,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const key = await this.key();
    if (!key)
      return this.failed(
        Object.assign(new Error("Gemini API key가 없습니다."), {
          statusCode: 401,
        }),
      );
    const harness = new WorkspaceTools(
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
    const contents: Array<Record<string, unknown>> = [
      { role: "user", parts: [{ text: request.prompt }] },
    ];
    let measured = true;
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    try {
      for (let turn = 0; turn < (harness ? 48 : 1); turn += 1) {
        const response = await fetch(
          `${this.connection.baseUrl?.replace(/\/$/, "")}/models/${encodeURIComponent(request.model.modelId)}:generateContent?key=${encodeURIComponent(key)}`,
          {
            method: "POST",
            signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              contents,
              generationConfig: {
                thinkingConfig: {
                  thinkingLevel: request.model.reasoningEffort,
                },
              },
              ...(harness
                ? {
                    tools: [
                      {
                        functionDeclarations: providerToolDefinitions(
                          request.role,
                        ).map((tool) => ({
                          name: tool.name,
                          description: tool.description,
                          parameters: tool.inputSchema,
                        })),
                      },
                    ],
                  }
                : {}),
            }),
          },
        );
        const body = await this.json(response);
        const raw = body.usageMetadata as Record<string, number> | undefined;
        measured &&=
          typeof raw?.promptTokenCount === "number" &&
          typeof raw?.candidatesTokenCount === "number";
        usage.inputTokens += raw?.promptTokenCount ?? 0;
        usage.outputTokens += raw?.candidatesTokenCount ?? 0;
        usage.totalTokens += raw?.totalTokenCount ?? 0;
        const candidate = (
          body.candidates as Array<Record<string, unknown>> | undefined
        )?.[0];
        const content = candidate?.content as
          Record<string, unknown> | undefined;
        const parts = Array.isArray(content?.parts)
          ? (content.parts as GeminiPart[])
          : [];
        const calls = parts.filter((part) => part.functionCall);
        if (calls.length && harness) {
          contents.push({ role: "model", parts });
          const replies = [];
          for (const part of calls) {
            const call = part.functionCall!;
            let result;
            try {
              result = await harness.execute(call.name, call.args ?? {});
            } catch (error) {
              result = {
                error: error instanceof Error ? error.message : String(error),
              };
            }
            replies.push({
              functionResponse: { name: call.name, response: result },
            });
          }
          contents.push({ role: "user", parts: replies });
          continue;
        }
        const text = parts
          .filter((part) => !part.thought)
          .map((part) => part.text ?? "")
          .join("\n");
        if (!text.trim())
          return { text: "", exitCode: 74, error: emptyResponseError(this.id) };
        return {
          text,
          exitCode: 0,
          ...(measured ? { usage } : {}),
          rawModelId: request.model.modelId,
        };
      }
      return this.failed(
        new Error("Gemini Worker tool turn 상한을 초과했습니다."),
      );
    } catch (error) {
      return this.failed(error);
    }
  }
}

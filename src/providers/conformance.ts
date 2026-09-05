import type {
  AgentRequest,
  AgentResult,
  ProviderAdapter,
  ConnectionConfig,
  ModelDescriptor,
  AgentRole,
} from "../types.js";
import {
  probeProvider,
  type CapabilityReport,
} from "../gateway/capabilities.js";
export type ProviderEvent =
  { type: "result"; result: AgentResult } | { type: "error"; message: string };
export interface InvocationRequest {
  invocationId: string;
  attemptId: string;
  runId: string;
  nodeId: string;
  generation: number;
  iteration?: number;
  role: AgentRole;
  workspaceRoot: string;
  model: ModelDescriptor;
  context: { prompt: string; sessionId?: string };
  permissions: {
    readPaths: string[];
    writePaths: string[];
    excludePaths?: string[];
  };
  outputSchema?: object;
  deadlineAt: string;
}
export interface ProviderAdapterV2 {
  describe(): { connectionId: string; mode: string; adapter: string };
  probe(): Promise<CapabilityReport>;
  listModels(): ReturnType<ProviderAdapter["listModels"]>;
  invoke(
    request: InvocationRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent>;
}
/** Existing transports expose complete results; token streaming is never fabricated. */
export function adaptProvider(
  connection: ConnectionConfig,
  adapter: ProviderAdapter,
): ProviderAdapterV2 {
  return {
    describe: () => ({
      connectionId: connection.id,
      mode: adapter.mode,
      adapter: adapter.id,
    }),
    probe: () => probeProvider(connection, adapter),
    listModels: () => adapter.listModels(),
    async *invoke(request, signal) {
      try {
        const remaining = Date.parse(request.deadlineAt) - Date.now();
        if (!Number.isFinite(remaining) || remaining <= 0)
          throw new Error("Invocation deadline exceeded");
        const input: AgentRequest = {
          runId: request.runId,
          nodeId: request.nodeId,
          generation: request.generation,
          iteration: request.iteration,
          role: request.role,
          model: request.model,
          projectRoot: request.workspaceRoot,
          prompt: request.context.prompt,
          sessionId: request.context.sessionId,
          readPaths: request.permissions.readPaths,
          writePaths: request.permissions.writePaths,
          excludePaths: request.permissions.excludePaths,
        };
        yield {
          type: "result",
          result: await adapter.invoke(
            input,
            AbortSignal.any([
              signal,
              AbortSignal.timeout(Math.ceil(remaining)),
            ]),
          ),
        };
      } catch (e) {
        yield {
          type: "error",
          message: e instanceof Error ? e.message : String(e),
        };
      }
    },
  };
}

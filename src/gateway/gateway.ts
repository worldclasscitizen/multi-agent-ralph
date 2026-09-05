import { adaptProvider } from "../providers/conformance.js";
import { gitStatus } from "../git.js";
import { classifyProviderError } from "../providers/errors.js";
import { randomUUID } from "node:crypto";
import { adapterMap } from "../providers/index.js";
import type {
  AgentRequest,
  AgentResult,
  ProjectConfig,
  RouteEntry,
} from "../types.js";
import { RalphError, redact, sleep } from "../util.js";
import type { RunEvent } from "../graph/schema.js";
import { BudgetCounter } from "../runtime/budget.js";
import { ConnectionLimits } from "./limits.js";
import { ProviderCircuits } from "./circuits.js";

export class ProviderGateway {
  readonly adapters;
  readonly circuits = new ProviderCircuits();
  readonly limits: ConnectionLimits;
  constructor(
    readonly config: ProjectConfig,
    readonly budget: BudgetCounter,
    readonly emit: (event: RunEvent) => Promise<unknown>,
    readonly retryDelay = 2000,
  ) {
    this.adapters = adapterMap(config);
    this.limits = new ConnectionLimits(budget.limits.connectionConcurrency);
  }
  async invoke(
    routes: RouteEntry[],
    request: Omit<AgentRequest, "model">,
    signal: AbortSignal,
    validate?: (text: string) => void,
    hardPin = false,
  ): Promise<{ result: AgentResult; route: RouteEntry }> {
    const invocationId = randomUUID();
    let attempts = 0;
    let last = "No approved model available";
    let lastKind = "";
    let prompt = request.prompt;
    for (const route of hardPin ? routes.slice(0, 1) : routes) {
      const adapter = this.adapters.get(route.connectionId);
      if (!adapter) continue;
      const key = `${route.connectionId}/${route.modelId}`;
      if (
        !this.circuits.available(key) ||
        !this.circuits.available(route.connectionId)
      )
        continue;
      const auth = await adapter.authStatus();
      if (auth.status === "unauthenticated")
        throw new RalphError(
          `Authentication required: ${route.connectionId}`,
          "authentication",
          77,
        );
      for (let n = 0; n < 2 && attempts < 6; n++) {
        signal.throwIfAborted();
        const result = await this.limits.use(
          route.connectionId,
          signal,
          async () => {
            this.budget.reserveAttempt();
            attempts++;
            const attemptId = randomUUID(),
              started = Date.now();
            await this.emit({
              type: "invocation.started",
              payload: {
                invocationId,
                attemptId,
                nodeId: request.nodeId,
                generation: request.generation ?? 0,
                iteration: request.iteration ?? 0,
                connectionId: route.connectionId,
                modelId: route.modelId,
                role: request.role,
              },
            });
            this.circuits.claim(key);
            this.circuits.claim(route.connectionId);
            let result: AgentResult;
            const timeout = AbortSignal.timeout(
              Math.min(900_000, this.budget.remainingMs()),
            );
            try {
              const connection = this.config.connections.find(
                (c) => c.id === route.connectionId,
              ) ?? {
                id: route.connectionId,
                adapter: adapter.id,
                provider: route.provider,
                enabled: true,
                mode: adapter.mode,
              };
              const stream = adaptProvider(connection, adapter).invoke(
                {
                  invocationId,
                  attemptId,
                  runId: request.runId,
                  nodeId: request.nodeId,
                  generation: request.generation ?? 0,
                  iteration: request.iteration,
                  role: request.role,
                  workspaceRoot: request.projectRoot,
                  model: { ...route, mode: adapter.mode },
                  context: { prompt, sessionId: request.sessionId },
                  permissions: {
                    readPaths: request.readPaths ?? ["**"],
                    writePaths: request.writePaths ?? [],
                    excludePaths: request.excludePaths ?? [],
                  },
                  deadlineAt: new Date(
                    Date.now() + Math.min(900_000, this.budget.remainingMs()),
                  ).toISOString(),
                },
                AbortSignal.any([signal, timeout]),
              );
              let final: AgentResult | undefined;
              for await (const event of stream) {
                if (event.type === "error") throw new Error(event.message);
                final = event.result;
              }
              if (!final)
                throw new Error("Adapter stream ended without a result");
              result = final;
            } catch (error) {
              if (signal.aborted) {
                await this.emit({
                  type: "invocation.finished",
                  payload: {
                    attemptId,
                    nodeId: request.nodeId,
                    generation: request.generation ?? 0,
                    iteration: request.iteration ?? 0,
                    connectionId: route.connectionId,
                    modelId: route.modelId,
                    durationMs: Date.now() - started,
                    error: "Cancelled after adapter returned control",
                  },
                });
                throw error;
              }
              result = {
                text: "",
                exitCode: 1,
                error: classifyProviderError({
                  message: redact(
                    error instanceof Error ? error.message : String(error),
                  ),
                }),
              };
            }
            if (result.exitCode === 0) {
              try {
                if (!result.text.trim()) throw new Error("Empty response");
                validate?.(result.text);
              } catch (error) {
                result = {
                  ...result,
                  exitCode: 4,
                  error: {
                    kind: "schema_error",
                    retryable: true,
                    message: String(error),
                  },
                };
                prompt = `${request.prompt}\nPrevious output validation failed: ${redact(String(error))}. Return a corrected result.`;
              }
            }
            await this.emit({
              type: "invocation.finished",
              payload: {
                attemptId,
                nodeId: request.nodeId,
                generation: request.generation ?? 0,
                iteration: request.iteration ?? 0,
                connectionId: route.connectionId,
                modelId: result.rawModelId ?? route.modelId,
                durationMs: Date.now() - started,
                ...(result.usage ? { usage: result.usage } : {}),
                ...(result.error
                  ? { error: redact(result.error.message) }
                  : {}),
              },
            });
            return result;
          },
        );
        if (result.exitCode === 0) {
          this.circuits.success(key);
          this.circuits.success(route.connectionId);
          return { result, route };
        }
        last = result.error?.message ?? "Provider returned no result";
        lastKind = result.error?.kind ?? "";
        if (!result.error?.retryable)
          throw new RalphError(
            redact(last),
            result.error?.kind ?? "provider_error",
            10,
          );
        if (
          request.role === "worker" &&
          request.writePaths &&
          (await gitStatus(request.projectRoot)).trim()
        )
          throw new RalphError(
            "Provider failed after changing files; inspect partial work before retrying",
            "partial_worker",
            10,
          );
        if (result.error?.kind === "context_overflow") {
          if (!request.compactPrompt)
            throw new RalphError(
              "Context exceeds model capacity; preserve the contract and replan with a larger approved context window",
              "context_overflow",
              10,
            );
          prompt = request.compactPrompt;
        }
        if (n === 0) {
          const delay =
            result.error?.retryAfterMs ??
            this.retryDelay +
              Math.floor(Math.random() * Math.min(this.retryDelay, 350));
          if (delay >= this.budget.remainingMs())
            throw new RalphError(
              "Provider retry delay exceeds remaining budget",
              "budget_exhausted",
              10,
            );
          await sleep(delay, signal);
        }
      }
      const circuitKey = lastKind === "rate_limit" ? route.connectionId : key;
      const until = this.circuits.trip(circuitKey);
      await this.emit({
        type: "circuit.changed",
        payload: { key: circuitKey, retryAt: until, reason: redact(last) },
      });
      if (attempts >= 6) break;
    }
    throw new RalphError(redact(last), "providers_blocked", 10);
  }
}

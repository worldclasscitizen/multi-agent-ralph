import { assertTransition } from "../runtime/transitions.js";
import { mkdir, readFile, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Journal, durableWrite } from "./journal.js";
import {
  digest,
  safeId,
  type EventEnvelope,
  type RunEvent,
  type GraphRunState,
  type GraphRevision,
  type NodeStatus,
} from "../graph/schema.js";
import { RalphError, redact } from "../util.js";

export function replay(runId: string, events: EventEnvelope[]): GraphRunState {
  const state: GraphRunState = {
    schemaVersion: 2,
    runId,
    status: "planning",
    revision: 1,
    seq: 0,
    nodes: {},
    attempts: 0,
    activeMs: 0,
    startedAt: events[0]?.timestamp ?? new Date().toISOString(),
    updatedAt: events[0]?.timestamp ?? new Date().toISOString(),
    commands: {},
  };
  for (const event of events) {
    state.seq = event.seq;
    state.updatedAt = event.timestamp;
    const p = event.payload;
    switch (event.type) {
      case "run.status": {
        const p = event.payload;
        state.status = p.status;
        state.message = p.message;
        if (p.resultHead) state.resultHead = p.resultHead;
        break;
      }
      case "graph.revised": {
        const g = event.payload.graph;
        state.revision = g.revision;
        state.nodes = Object.fromEntries(
          g.nodes.map((n) => [
            n.nodeId,
            state.nodes[n.nodeId]?.generation === n.generation
              ? state.nodes[n.nodeId]!
              : {
                  status: "pending",
                  generation: n.generation,
                  iteration: state.nodes[n.nodeId]?.iteration ?? 0,
                },
          ]),
        );
        break;
      }
      case "node.status": {
        const p = event.payload;
        const old = state.nodes[p.nodeId];
        if (!old || old.generation !== p.generation)
          throw new RalphError(
            "Node event references unknown generation",
            "invalid_event",
            4,
          );
        state.nodes[p.nodeId] = {
          ...old,
          status: p.status,
          ...(p.iteration !== undefined ? { iteration: p.iteration } : {}),
          ...(p.result ? { result: p.result } : {}),
          ...(p.error ? { error: p.error } : {}),
          ...(p.status === "running" && !old.startedAt
            ? { startedAt: event.timestamp }
            : {}),
          ...(["completed", "failed", "blocked", "cancelled"].includes(p.status)
            ? { endedAt: event.timestamp }
            : {}),
        };
        break;
      }
      case "route.selected": {
        const p = event.payload;
        const node = state.nodes[p.nodeId];
        if (node) {
          node.modelId = p.modelId;
          node.connectionId = p.connectionId;
          node.rationale = p.reason;
        }
        break;
      }
      case "invocation.started":
        state.attempts++;
        {
          const p = event.payload;
          const node = state.nodes[p.nodeId];
          if (node && (p.role === "worker" || !node.modelId)) {
            node.modelId = p.modelId;
            node.connectionId = p.connectionId;
          }
        }
        break;
      case "runtime.elapsed":
        state.activeMs += event.payload.ms;
        break;
      case "command.applied":
        state.commands[event.payload.commandId] = event.payload.result;
        break;
    }
  }
  return state;
}
export class RunStore {
  readonly directory: string;
  readonly journal: Journal;
  private token?: string;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    readonly root: string,
    readonly runId: string,
  ) {
    this.directory = join(root, "runs", safeId(runId));
    this.journal = new Journal(join(this.directory, "events.jsonl"), runId);
  }
  async acquire(recovery?: {
    ownerToken: string;
    recoveryToken: string;
  }): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.root, "locks", "graph-owner.json");
    await mkdir(join(this.root, "locks"), { recursive: true });
    const token = randomUUID();
    if (recovery) {
      const guard = JSON.parse(
        await readFile(join(this.root, "locks/graph-recovery.lock"), "utf8"),
      );
      const owner = JSON.parse(await readFile(path, "utf8"));
      if (
        guard.token !== recovery.recoveryToken ||
        guard.pid !== process.pid ||
        owner.token !== recovery.ownerToken ||
        owner.runId !== this.runId
      )
        throw new RalphError("Recovery ownership changed", "run_locked", 9);
      let dead = false;
      try {
        process.kill(owner.pid, 0);
      } catch (e) {
        dead = (e as NodeJS.ErrnoException).code === "ESRCH";
      }
      if (!dead)
        throw new RalphError(
          "Previous supervisor death is not confirmed",
          "run_locked",
          9,
        );
      // Atomic replacement keeps the owner path continuously present, blocking other acquisitions.
      await durableWrite(
        path,
        JSON.stringify({
          runId: this.runId,
          pid: process.pid,
          token,
          startedAt: new Date(
            Date.now() - process.uptime() * 1000,
          ).toISOString(),
        }),
      );
      this.token = token;
      return;
    }
    try {
      const f = await open(path, "wx", 0o600);
      try {
        await f.writeFile(
          JSON.stringify({
            runId: this.runId,
            pid: process.pid,
            token,
            startedAt: new Date(
              Date.now() - process.uptime() * 1000,
            ).toISOString(),
          }),
        );
        await f.sync();
      } finally {
        await f.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST")
        throw new RalphError(
          "A supervisor owns this project; inspect recovery before replacing it",
          "run_locked",
          9,
        );
      throw e;
    }
    this.token = token;
  }
  async release(): Promise<void> {
    if (!this.token) return;
    const path = join(this.root, "locks", "graph-owner.json");
    const lock = JSON.parse(await readFile(path, "utf8"));
    if (lock.token !== this.token)
      throw new RalphError("Supervisor ownership changed", "run_locked", 9);
    await unlink(path);
    this.token = undefined;
  }
  async append(event: RunEvent, revision: number): Promise<EventEnvelope> {
    if (!this.token)
      throw new RalphError(
        "Only the owning supervisor may append",
        "run_locked",
        9,
      );
    const action = this.writes.then(async () => {
      assertTransition(await this.state(), event);
      return this.journal.append(event, revision);
    });
    this.writes = action.catch(() => {});
    return action;
  }
  async readAfter(seq = 0): Promise<EventEnvelope[]> {
    return (await this.journal.read()).filter((e) => e.seq > seq);
  }
  async state(): Promise<GraphRunState> {
    return replay(this.runId, await this.journal.read());
  }
  async saveSnapshot(): Promise<GraphRunState> {
    const state = await this.state();
    await durableWrite(
      join(this.directory, "snapshot.json"),
      JSON.stringify(state),
    );
    return state;
  }
  async loadSnapshot(): Promise<GraphRunState> {
    return this.state();
  }
  async putArtifact(value: unknown): Promise<string> {
    value = sanitize(value);
    const content = JSON.stringify(value);
    const id = digest(value);
    const dir = join(this.directory, "artifacts");
    await mkdir(dir, { recursive: true });
    try {
      const file = await open(join(dir, `${id}.json`), "wx", 0o600);
      try {
        await file.writeFile(content);
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      await this.artifact(id);
    }
    return id;
  }
  async artifact(id: string): Promise<unknown> {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new RalphError("Invalid artifact ID", "invalid_id", 4);
    const value = JSON.parse(
      await readFile(join(this.directory, "artifacts", `${id}.json`), "utf8"),
    );
    if (digest(value) !== id)
      throw new RalphError("Artifact integrity failed", "artifact_corrupt", 4);
    return value;
  }
  async graph(): Promise<GraphRevision> {
    const rows = await this.readAfter();
    const event = [...rows].reverse().find((e) => e.type === "graph.revised");
    if (!event || event.type !== "graph.revised")
      throw new RalphError("No graph", "run_not_found", 2);
    return event.payload.graph;
  }
}
export const TERMINAL_NODES: NodeStatus[] = [
  "completed",
  "failed",
  "blocked",
  "cancelled",
];

function sanitize(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /^(password|secret|apiKey|accessToken)$/i.test(k)
          ? "[REDACTED]"
          : sanitize(v),
      ]),
    );
  return value;
}

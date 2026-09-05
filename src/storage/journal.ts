import {
  mkdir,
  open,
  readFile,
  writeFile,
  rename,
  stat,
} from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  validateRunEvent,
  digest,
  type EventEnvelope,
  type RunEvent,
} from "../graph/schema.js";
import { RalphError } from "../util.js";

export async function durableWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}
export class Journal {
  private cached?: { key: string; rows: EventEnvelope[] };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly path: string,
    readonly runId: string,
  ) {}
  async read(repair = false): Promise<EventEnvelope[]> {
    let data: Buffer;
    let key = "";
    try {
      const info = await stat(this.path, { bigint: true });
      key = `${info.size}/${info.mtimeNs}/${info.ctimeNs}`;
      if (this.cached?.key === key) return structuredClone(this.cached.rows);
      data = await readFile(this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const end = data.lastIndexOf(10) + 1;
    if (end !== data.length) {
      if (!repair)
        throw new RalphError(
          "Journal has an incomplete tail; resume to recover",
          "journal_tail",
          10,
        );
      await writeFile(`${this.path}.tail-${randomUUID()}`, data, {
        mode: 0o600,
      });
      const f = await open(this.path, "r+");
      try {
        await f.truncate(end);
        await f.sync();
      } finally {
        await f.close();
      }
      data = data.subarray(0, end);
    }
    const rows: EventEnvelope[] = [];
    let previousHash = "";
    const ids = new Set<string>();
    for (const line of data.toString("utf8").split("\n").slice(0, -1)) {
      let event: EventEnvelope;
      try {
        event = JSON.parse(line);
      } catch {
        throw new RalphError(
          "Journal record is corrupt",
          "journal_corrupt",
          10,
        );
      }
      const { hash, ...unsigned } = event;
      if (
        event.schemaVersion !== 2 ||
        event.runId !== this.runId ||
        event.seq !== rows.length + 1 ||
        event.previousHash !== previousHash ||
        hash !== digest(unsigned) ||
        ids.has(event.eventId)
      )
        throw new RalphError(
          "Journal integrity check failed",
          "journal_corrupt",
          10,
        );
      validateEvent(event);
      rows.push(event);
      ids.add(event.eventId);
      previousHash = hash;
    }
    if (end === data.length && !repair)
      this.cached = { key, rows: structuredClone(rows) };
    return rows;
  }
  append(event: RunEvent, revision: number): Promise<EventEnvelope> {
    const action = this.queue.then(async () => {
      validateEvent(event);
      const rows = await this.read();
      const annotations = Object.fromEntries(
        ["nodeId", "generation", "iteration", "attemptId"]
          .filter((key) => key in event.payload)
          .map((key) => [key, (event.payload as Record<string, unknown>)[key]]),
      );
      const unsigned = {
        ...annotations,
        ...event,
        schemaVersion: 2 as const,
        eventId: randomUUID(),
        runId: this.runId,
        seq: rows.length + 1,
        graphRevision: revision,
        timestamp: new Date().toISOString(),
        previousHash: rows.at(-1)?.hash ?? "",
      };
      const stored = { ...unsigned, hash: digest(unsigned) } as EventEnvelope;
      await mkdir(dirname(this.path), { recursive: true });
      const file = await open(this.path, "a", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(stored)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      this.cached = undefined;
      return stored;
    });
    this.queue = action.catch(() => {});
    return action;
  }
}
const validateEvent = validateRunEvent;

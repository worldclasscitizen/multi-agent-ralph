import { mkdir, open, readFile, readdir, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { safeId, digest } from "../graph/schema.js";
import { RalphError } from "../util.js";
import type { RunStore } from "../storage/run-store.js";
export interface RunCommand {
  commandId: string;
  expectedRevision: number;
  type: "stop" | "cancel" | "approve_final" | "note" | "resume";
  note?: string;
}
export async function submitCommand(
  store: RunStore,
  command: RunCommand,
): Promise<{ created: boolean }> {
  safeId(command.commandId);
  if (
    !["stop", "cancel", "approve_final", "note", "resume"].includes(
      command.type,
    ) ||
    !Number.isInteger(command.expectedRevision) ||
    command.expectedRevision < 1 ||
    (command.note !== undefined && typeof command.note !== "string") ||
    Object.keys(command).some(
      (key) => !["commandId", "expectedRevision", "type", "note"].includes(key),
    )
  )
    throw new RalphError("Invalid command", "invalid_command", 4);
  const dir = join(store.directory, "commands"),
    path = join(dir, `${command.commandId}.json`);
  const existing = async () => {
    try {
      const saved = JSON.parse(await readFile(path, "utf8"));
      if (digest(saved) !== digest(command))
        throw new RalphError(
          "Command ID reused with different payload",
          "command_conflict",
          4,
        );
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  };
  if (await existing()) return { created: false };
  const state = await store.state();
  if (state.revision !== command.expectedRevision)
    throw new RalphError("Graph revision changed", "revision_conflict", 4);
  await mkdir(dir, { recursive: true });
  const temporary = join(dir, `${command.commandId}.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(command));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, path);
    return { created: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    await existing();
    return { created: false };
  } finally {
    await unlink(temporary);
  }
}

export async function pendingCommands(store: RunStore): Promise<RunCommand[]> {
  const state = await store.state();
  let files: string[];
  try {
    files = await readdir(join(store.directory, "commands"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const result: RunCommand[] = [];
  for (const file of files.filter((x) => x.endsWith(".json")).sort()) {
    const c: RunCommand = JSON.parse(
      await readFile(join(store.directory, "commands", file), "utf8"),
    );
    if (!Object.hasOwn(state.commands, c.commandId)) result.push(c);
  }
  return result;
}

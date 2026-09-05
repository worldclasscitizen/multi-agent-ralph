import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { globalConfigDir } from "../config.js";
import { gitHead, gitStatus } from "../git.js";
import { digest } from "../graph/schema.js";
import { redact } from "../util.js";
export interface ContextSnapshot {
  schemaVersion: 1;
  request: string;
  projectRoot: string;
  baseHead: string;
  gitStatus: string;
  createdAt: string;
  sources: Array<{
    kind: string;
    source: string;
    content: string;
    hash: string;
    truncated: boolean;
  }>;
  hostStatus: "provided" | "unavailable";
}
export async function collectContext(
  projectRoot: string,
  request: string,
  host?: { summary: string },
): Promise<ContextSnapshot> {
  const sources: ContextSnapshot["sources"] = [];
  for (const [kind, path] of [
    ["project", join(projectRoot, "AGENTS.md")],
    ["profile", join(globalConfigDir(), "profile.json")],
  ]) {
    try {
      const raw = await readFile(path!, "utf8");
      const content = redact(raw.slice(0, 16_000));
      sources.push({
        kind: kind!,
        source: path!,
        content,
        hash: digest(content),
        truncated: raw.length > 16_000,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (host && typeof host.summary !== "string")
    throw new Error("Host context requires a summary string");
  if (host) {
    const content = redact(host.summary.slice(0, 24_000));
    sources.push({
      kind: "host",
      source: "explicit-input",
      content,
      hash: digest(content),
      truncated: host.summary.length > 24_000,
    });
  }
  return {
    schemaVersion: 1,
    request,
    projectRoot,
    baseHead: await gitHead(projectRoot),
    gitStatus: await gitStatus(projectRoot),
    createdAt: new Date().toISOString(),
    sources,
    hostStatus: host ? "provided" : "unavailable",
  };
}

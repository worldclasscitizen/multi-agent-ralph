import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import {
  delimiter,
  dirname,
  join,
  resolve as resolvePath,
  isAbsolute,
} from "node:path";
import { spawn } from "node:child_process";

export class RalphError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly exitCode = 1,
  ) {
    super(message);
    this.name = "RalphError";
  }
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  const executable = await resolveExecutable(command);
  command = executable.command;
  args = [...executable.prefix, ...args];
  options.signal?.throwIfAborted();
  const windowsShell =
    process.platform === "win32" && /(?:^|[\\/])cmd(?:\.exe)?$/i.test(command);
  if (windowsShell && args.at(-2)?.toLowerCase() === "/c")
    args = [...args.slice(0, -1), '"' + args.at(-1) + '"'];
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      windowsVerbatimArguments: windowsShell,
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined,
      killing = false,
      abortReason: unknown;
    let termination: Promise<void> = Promise.resolve();
    const stop = (reason: unknown) => {
      if (killing || child.exitCode !== null || !child.pid) return;
      killing = true;
      abortReason = reason;
      if (process.platform === "win32") {
        termination = new Promise<void>((done) => {
          const killer = spawn(
            "taskkill.exe",
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" },
          );
          killer.once("error", () => {
            child.kill();
            done();
          });
          killer.once("close", () => done());
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const abort = () => stop(options.signal?.reason ?? new Error("Aborted"));
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", () => {});
    child.once("error", reject);
    child.once("close", async (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      await termination;
      if (abortReason) {
        reject(abortReason);
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
    child.stdin.end(options.input);
    if (options.signal?.aborted) abort();
    if (options.timeoutMs)
      timer = setTimeout(
        () => stop(new Error("Command timed out")),
        options.timeoutMs,
      );
  });
}

/** Resolve npm's Windows launchers without sending user arguments through a shell. */
export async function resolveExecutable(
  command: string,
): Promise<{ command: string; prefix: string[] }> {
  if (
    process.platform !== "win32" ||
    !["codex", "claude", "gemini", "agy"].includes(command)
  )
    return { command, prefix: [] };
  const candidates = await executableCandidates(command);
  const native = candidates.find((p) => p.toLowerCase().endsWith(".exe"));
  if (native) return { command: native, prefix: [] };
  const shim = candidates.find((p) => p.toLowerCase().endsWith(".cmd"));
  if (!shim) return { command, prefix: [] };
  const text = await readFile(shim, "utf8");
  const relative = text.match(
    /"%dp0%\\(node_modules\\[^"\r\n]+\.(?:[cm]?js|exe))"/i,
  )?.[1];
  if (!relative)
    throw new RalphError(
      `Unsupported CLI launcher: ${command}`,
      "unavailable",
      10,
    );
  const entry = resolvePath(dirname(shim), relative);
  return entry.endsWith(".exe")
    ? { command: entry, prefix: [] }
    : { command: process.execPath, prefix: [entry] };
}

async function executableCandidates(command: string): Promise<string[]> {
  const extensions =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ".com", ""] : [""];
  const directories =
    isAbsolute(command) || /[\\/]/.test(command)
      ? [""]
      : (process.env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((p) => p.replace(/^"|"$/g, ""));
  const paths: string[] = [];
  for (const directory of directories)
    for (const extension of extensions) {
      const path = directory
        ? join(directory, command + extension)
        : command + extension;
      try {
        await access(path);
        paths.push(path);
      } catch {
        /* Continue PATH search. */
      }
    }
  return paths;
}
export async function commandExists(
  command: string,
): Promise<string | undefined> {
  return (await executableCandidates(command))[0];
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function atomicWrite(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, path);
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function now(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string): string {
  return `${prefix}-${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}-${randomBytes(3).toString("hex")}`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

export function redact(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED]")
    .replace(
      /\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi,
      "$1=[REDACTED]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
}

export function parseJsonObject<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced) as T;
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start)
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    throw new RalphError(
      "모델 출력에서 JSON 객체를 찾지 못했습니다.",
      "schema_error",
    );
  }
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

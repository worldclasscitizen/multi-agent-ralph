import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolDefinition, AgentRole } from "./types.js";
import { normalizePattern, covered } from "./graph/compiler.js";
import { gitStatus } from "./git.js";
import { runCommand, sha256 } from "./util.js";

const PROTECTED = [
  /^\.git(?:\/|$)/,
  /^\.ralph(?:\/|$)/,
  /^\.antigravity(?:\/|$)/,
  /^\.claude(?:\/|$)/,
  /^\.env(?:$|\.(?!example$))/,
  /\.(?:pem|key|p12|pfx)$/i,
];

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "list_files",
    description: "프로젝트의 Git 추적·비무시 파일 목록을 조회합니다.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 1000 } },
      additionalProperties: false,
    },
  },
  {
    name: "search_text",
    description: "UTF-8 파일에서 리터럴 문자열을 검색합니다.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "파일과 SHA-256을 읽습니다.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description: "현재 SHA를 확인하고 정확한 문자열을 원자적으로 치환합니다.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        expectedSha256: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        expectedOccurrences: { type: "integer", minimum: 1 },
      },
      required: [
        "path",
        "expectedSha256",
        "oldText",
        "newText",
        "expectedOccurrences",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "신규 파일을 만들거나 현재 SHA 확인 후 원자적으로 덮어씁니다.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        expectedSha256: { type: ["string", "null"] },
      },
      required: ["path", "content", "expectedSha256"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_file",
    description: "현재 SHA를 확인한 파일을 삭제합니다.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        expectedSha256: { type: "string" },
      },
      required: ["path", "expectedSha256"],
      additionalProperties: false,
    },
  },
  {
    name: "git_status",
    description: "변경 없이 Git status를 조회합니다.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "git_diff",
    description: "변경 없이 Git diff를 조회합니다.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "run_verifier",
    description: "등록된 결정적 verifier 명령을 실행합니다.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

export function providerToolDefinitions(role: AgentRole): ToolDefinition[] {
  const readOnly = new Set([
    "list_files",
    "search_text",
    "read_file",
    "git_status",
    "git_diff",
  ]);
  return TOOL_DEFINITIONS.filter(
    (tool) =>
      tool.name !== "run_verifier" &&
      (role === "worker" || readOnly.has(tool.name)),
  );
}

interface OriginalFile {
  path: string;
  content?: Buffer;
  mode?: number;
}

export class WorkspaceTools {
  private readonly originals = new Map<string, OriginalFile>();
  private calls = 0;

  constructor(
    private readonly root: string,
    private readonly verifierCommands: string[],
    private readonly maxCalls = 160,
    private readonly scope?: {
      writePaths?: string[];
      readPaths?: string[];
      excludePaths?: string[];
    },
    private readonly signal?: AbortSignal,
  ) {}

  private safePath(input: string): { absolute: string; relative: string } {
    if (!input || isAbsolute(input))
      throw new Error("절대 경로 또는 빈 경로는 허용되지 않습니다.");
    const normalized = input.replaceAll("\\", "/");
    if (normalized.split("/").some((part) => part === ".." || part === ""))
      throw new Error("상위 경로 참조는 허용되지 않습니다.");
    if (PROTECTED.some((pattern) => pattern.test(normalized.toLowerCase())))
      throw new Error(`보호된 경로입니다: ${normalized}`);
    normalizePattern(normalized);
    const absolute = resolve(this.root, normalized);
    const rel = relative(this.root, absolute);
    if (rel.startsWith(`..${sep}`) || rel === "..")
      throw new Error("프로젝트 밖 경로는 허용되지 않습니다.");
    return { absolute, relative: normalized };
  }

  private async assertNoSymlink(path: string): Promise<void> {
    let cursor = this.root;
    for (const part of relative(this.root, path).split(sep)) {
      cursor = join(cursor, part);
      try {
        if ((await lstat(cursor)).isSymbolicLink())
          throw new Error(
            `심볼릭 링크 경로는 허용되지 않습니다: ${relative(this.root, cursor)}`,
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private async remember(path: string, relativePath: string): Promise<void> {
    if (this.originals.has(relativePath)) return;
    try {
      const info = await stat(path);
      this.originals.set(relativePath, {
        path,
        content: await readFile(path),
        mode: info.mode,
      });
    } catch {
      this.originals.set(relativePath, { path });
    }
  }

  private async atomicWrite(
    path: string,
    content: string,
    mode = 0o644,
  ): Promise<void> {
    if (Buffer.byteLength(content) > 2_097_152)
      throw new Error("쓰기 크기 2MB 상한을 초과했습니다.");
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.ralph-tmp`;
    await writeFile(temp, content, { mode });
    await rename(temp, path);
  }

  private async files(): Promise<string[]> {
    const result = await runCommand(
      "git",
      ["ls-files", "-co", "--exclude-standard", "-z"],
      { cwd: this.root },
    );
    if (result.exitCode !== 0)
      throw new Error(result.stderr || "파일 목록 조회 실패");
    return result.stdout
      .split("\0")
      .filter(Boolean)
      .filter(
        (path) => !this.scope?.readPaths || covered(path, this.scope.readPaths),
      )
      .filter(
        (path) =>
          !PROTECTED.some((pattern) => pattern.test(path.toLowerCase())),
      )
      .sort();
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (
      ["write_file", "edit_file", "delete_file"].includes(name) &&
      this.scope?.writePaths &&
      (!covered(String(input.path), this.scope.writePaths) ||
        covered(String(input.path), this.scope.excludePaths ?? []))
    )
      throw new Error("Write is outside approved node scope");
    if (
      name === "read_file" &&
      this.scope?.readPaths &&
      !covered(String(input.path), this.scope.readPaths)
    )
      throw new Error("Read is outside approved node scope");
    this.signal?.throwIfAborted();
    this.calls += 1;
    if (this.calls > this.maxCalls)
      throw new Error("도구 호출 상한을 초과했습니다.");
    if (name === "list_files") {
      const limit = Number(input.limit ?? 500);
      const files = await this.files();
      return { files: files.slice(0, limit), truncated: files.length > limit };
    }
    if (name === "search_text") {
      const query = String(input.query ?? "");
      const limit = Number(input.limit ?? 200);
      if (!query || query.length > 300)
        throw new Error("검색어 길이는 1~300자여야 합니다.");
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const file of await this.files()) {
        const absolute = resolve(this.root, file);
        try {
          await this.assertNoSymlink(absolute);
          if ((await stat(absolute)).size > 262_144) continue;
          const lines = (await readFile(absolute, "utf8")).split(/\r?\n/);
          lines.forEach((line, index) => {
            if (matches.length < limit && line.includes(query))
              matches.push({
                path: file,
                line: index + 1,
                text: line.slice(0, 500),
              });
          });
        } catch {
          // binary/unreadable files are skipped
        }
        if (matches.length >= limit) break;
      }
      return { matches, truncated: matches.length >= limit };
    }
    if (name === "read_file") {
      const target = this.safePath(String(input.path ?? ""));
      await this.assertNoSymlink(target.absolute);
      const bytes = await readFile(target.absolute);
      if (bytes.byteLength > 262_144)
        throw new Error("읽기 크기 256KB 상한을 초과했습니다.");
      const lines = bytes.toString("utf8").split(/(?<=\n)/);
      const start = Number(input.startLine ?? 1);
      const end = Number(input.endLine ?? Math.min(lines.length, start + 399));
      return {
        path: target.relative,
        sha256: sha256(bytes.toString("utf8")),
        startLine: start,
        endLine: Math.min(end, lines.length),
        totalLines: lines.length,
        content: lines.slice(start - 1, end).join(""),
      };
    }
    if (name === "edit_file") {
      const target = this.safePath(String(input.path ?? ""));
      await this.assertNoSymlink(target.absolute);
      const content = await readFile(target.absolute, "utf8");
      if (sha256(content) !== input.expectedSha256)
        throw new Error("파일이 읽은 뒤 변경되었습니다.");
      const oldText = String(input.oldText ?? "");
      const newText = String(input.newText ?? "");
      const expected = Number(input.expectedOccurrences ?? 1);
      const count = oldText ? content.split(oldText).length - 1 : 0;
      if (count !== expected)
        throw new Error(
          `치환 대상 개수가 다릅니다: expected=${expected}, actual=${count}`,
        );
      await this.remember(target.absolute, target.relative);
      const next = content.split(oldText).join(newText);
      await this.atomicWrite(
        target.absolute,
        next,
        (await stat(target.absolute)).mode,
      );
      return {
        path: target.relative,
        sha256: sha256(next),
        bytes: Buffer.byteLength(next),
      };
    }
    if (name === "write_file") {
      const target = this.safePath(String(input.path ?? ""));
      await this.assertNoSymlink(target.absolute);
      let current: string | undefined;
      try {
        current = await readFile(target.absolute, "utf8");
      } catch {
        current = undefined;
      }
      if (current === undefined && input.expectedSha256 !== null)
        throw new Error("신규 파일에는 expectedSha256=null이 필요합니다.");
      if (current !== undefined && sha256(current) !== input.expectedSha256)
        throw new Error("파일이 읽은 뒤 변경되었습니다.");
      await this.remember(target.absolute, target.relative);
      const content = String(input.content ?? "");
      await this.atomicWrite(
        target.absolute,
        content,
        current === undefined ? 0o644 : (await stat(target.absolute)).mode,
      );
      return {
        path: target.relative,
        sha256: sha256(content),
        bytes: Buffer.byteLength(content),
      };
    }
    if (name === "delete_file") {
      const target = this.safePath(String(input.path ?? ""));
      await this.assertNoSymlink(target.absolute);
      const current = await readFile(target.absolute, "utf8");
      if (sha256(current) !== input.expectedSha256)
        throw new Error("파일이 읽은 뒤 변경되었습니다.");
      await this.remember(target.absolute, target.relative);
      await unlink(target.absolute);
      return { path: target.relative, deleted: true };
    }
    if (name === "git_status") return { status: await gitStatus(this.root) };
    if (name === "git_diff") {
      if (
        this.scope?.readPaths &&
        !this.scope.readPaths.includes("**") &&
        (!input.path || !covered(String(input.path), this.scope.readPaths))
      )
        throw new Error("Diff is outside approved read scope");
      const args = ["diff", "--no-ext-diff", "--"];
      if (input.path) args.push(this.safePath(String(input.path)).relative);
      const result = await runCommand("git", args, { cwd: this.root });
      return {
        diff: result.stdout.slice(0, 65_536),
        truncated: result.stdout.length > 65_536,
      };
    }
    if (name === "run_verifier") {
      if (!this.verifierCommands.length)
        throw new Error("Verification is owned by the Ralph runtime");
      const results = [];
      for (const command of this.verifierCommands) {
        const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
        const args =
          process.platform === "win32"
            ? ["/d", "/s", "/c", command]
            : ["-lc", command];
        const result = await runCommand(shell, args, {
          cwd: this.root,
          timeoutMs: 900_000,
          signal: this.signal,
        });
        results.push({
          command,
          exitCode: result.exitCode,
          stdout: result.stdout.slice(-16_000),
          stderr: result.stderr.slice(-16_000),
        });
        if (result.exitCode !== 0) break;
      }
      return { results, ok: results.every((item) => item.exitCode === 0) };
    }
    throw new Error(`등록되지 않은 도구입니다: ${name}`);
  }

  async rollback(): Promise<void> {
    for (const original of [...this.originals.values()].reverse()) {
      if (original.content === undefined) {
        await unlink(original.path).catch(() => undefined);
      } else {
        await mkdir(dirname(original.path), { recursive: true });
        await writeFile(original.path, original.content, {
          mode: original.mode,
        });
      }
    }
  }
}

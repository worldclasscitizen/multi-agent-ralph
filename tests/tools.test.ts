import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { WorkspaceTools } from "../src/tools.js";
import { runCommand, sha256 } from "../src/util.js";

describe("API worker tool harness", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ralph-tools-"));
    await runCommand("git", ["init"], { cwd: root });
    await writeFile(join(root, "hello.txt"), "hello\n");
    await runCommand("git", ["add", "."], { cwd: root });
  });

  it("rejects path escape and protected files", async () => {
    const tools = new WorkspaceTools(root, ["git diff --check"]);
    await expect(
      tools.execute("read_file", { path: "../secret" }),
    ).rejects.toThrow("상위 경로");
    await expect(
      tools.execute("write_file", {
        path: ".env",
        content: "SECRET=x",
        expectedSha256: null,
      }),
    ).rejects.toThrow("보호된 경로");
  });

  it("uses SHA guards and can roll back partial writes", async () => {
    const tools = new WorkspaceTools(root, ["git diff --check"]);
    await tools.execute("edit_file", {
      path: "hello.txt",
      expectedSha256: sha256("hello\n"),
      oldText: "hello",
      newText: "world",
      expectedOccurrences: 1,
    });
    expect(await readFile(join(root, "hello.txt"), "utf8")).toBe("world\n");
    await expect(
      tools.execute("edit_file", {
        path: "hello.txt",
        expectedSha256: sha256("hello\n"),
        oldText: "world",
        newText: "x",
        expectedOccurrences: 1,
      }),
    ).rejects.toThrow("변경되었습니다");
    await tools.rollback();
    expect(await readFile(join(root, "hello.txt"), "utf8")).toBe("hello\n");
  });
});

it("enforces exclusions within broad API write scope before touching files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-exclusion-"));
  await writeFile(join(root, "protected.txt"), "User data");
  const tools = new WorkspaceTools(root, [], 160, {
    writePaths: ["**"],
    readPaths: ["allowed.txt"],
    excludePaths: ["protected.txt"],
  });
  await expect(
    tools.execute("write_file", {
      path: "protected.txt",
      content: "changed",
      expectedSha256: sha256("User data"),
    }),
  ).rejects.toThrow(/scope/);
  expect(await readFile(join(root, "protected.txt"), "utf8")).toBe("User data");
  await expect(
    tools.execute("read_file", { path: "protected.txt" }),
  ).rejects.toThrow(/scope/);
  await expect(tools.execute("git_diff", {})).rejects.toThrow(/scope/);
  await expect(tools.execute("run_verifier", {})).rejects.toThrow(/runtime/);
});

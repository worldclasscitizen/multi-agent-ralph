import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand, RalphError } from "../util.js";
import { safeId, digest, type NodeResult } from "../graph/schema.js";
import type { RunStore } from "../storage/run-store.js";
import { assertCheckpointSafe, gitHead } from "../git.js";
import { durableWrite } from "../storage/journal.js";
export async function git(
  root: string,
  args: string[],
  input?: string,
): Promise<string> {
  const r = await runCommand("git", args, { cwd: root, input });
  if (r.exitCode !== 0)
    throw new RalphError(
      r.stderr || `git ${args[0]} failed`,
      "git_failure",
      10,
    );
  return args[0] === "diff" || args.includes("-z")
    ? r.stdout
    : r.stdout.trimEnd();
}
export class IntegrationConflict extends RalphError {
  constructor(
    readonly input: {
      root: string;
      inputHead: string;
      inputDigest: string;
      conflictErrors: Array<{ nodeId: string; message: string; patch: string }>;
    },
  ) {
    super("Integration requires conflict repair", "integration_conflict", 10);
  }
}
export class WorkspaceManager {
  constructor(
    readonly projectRoot: string,
    readonly store: RunStore,
    readonly baseHead: string,
  ) {}
  async prepare(
    nodeId: string,
    generation: number,
    dependencies: NodeResult[],
    options: { baseHead?: string; retainConflicts?: boolean } = {},
  ): Promise<{ root: string; inputHead: string; inputDigest: string }> {
    dependencies = [
      ...new Map(
        dependencies.map((d) => [
          `${d.nodeId}/${d.generation}/${d.outputHead}`,
          d,
        ]),
      ).values(),
    ];
    const root = join(
      this.store.directory,
      "workspaces",
      `${safeId(nodeId)}-${generation}`,
    );
    const baseHead = options.baseHead ?? this.baseHead;
    const inputDigest = digest({
      baseHead,
      dependencies: dependencies.map((x) => ({
        nodeId: x.nodeId,
        generation: x.generation,
        outputHead: x.outputHead,
        inputDigest: x.inputDigest,
        artifactIds: x.artifactIds,
      })),
    });
    const receipt = join(
      this.store.directory,
      "nodes",
      safeId(nodeId),
      String(generation),
      "workspace.json",
    );
    try {
      const old = JSON.parse(await readFile(receipt, "utf8"));
      if (old.inputDigest !== inputDigest)
        throw new RalphError("Workspace input changed", "input_changed", 10);
      await git(root, ["rev-parse", "HEAD"]);
      if (old.conflictErrors?.length) throw new IntegrationConflict(old);
      return old;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await mkdir(join(this.store.directory, "workspaces"), { recursive: true });
    await git(this.projectRoot, [
      "worktree",
      "add",
      "--detach",
      root,
      baseHead,
    ]);
    const conflictErrors: Array<{
      nodeId: string;
      message: string;
      patch: string;
    }> = [];
    for (const dep of dependencies) {
      if (!dep.outputHead || !dep.inputHead || dep.outputHead === dep.inputHead)
        continue;
      const patch = await git(this.projectRoot, [
        "diff",
        "--binary",
        dep.inputHead,
        dep.outputHead,
        "--",
      ]);
      if (patch)
        try {
          await git(root, ["apply", "--index", "--3way", "-"], patch);
        } catch (e) {
          if (!options.retainConflicts) throw e;
          conflictErrors.push({
            nodeId: dep.nodeId,
            message: String(e),
            patch,
          });
          await git(root, ["add", "-A", "--", "."]);
        }
    }
    await git(root, [
      "-c",
      "user.name=Ralph",
      "-c",
      "user.email=ralph@localhost",
      "commit",
      "--allow-empty",
      "-m",
      `Ralph input ${nodeId}`,
    ]);
    const inputHead = await gitHead(root);
    await durableWrite(
      receipt,
      JSON.stringify({
        root,
        inputHead,
        inputDigest,
        ...(conflictErrors.length ? { conflictErrors } : {}),
      }),
    );
    if (conflictErrors.length)
      throw new IntegrationConflict({
        root,
        inputHead,
        inputDigest,
        conflictErrors,
      });
    return { root, inputHead, inputDigest };
  }
  async checkpoint(
    root: string,
    nodeId: string,
    generation: number,
    iteration: number,
  ): Promise<string> {
    await assertCheckpointSafe(root);
    await git(root, ["add", "-A", "--", "."]);
    await git(root, [
      "-c",
      "user.name=Ralph",
      "-c",
      "user.email=ralph@localhost",
      "commit",
      "--allow-empty",
      "-m",
      `Ralph ${nodeId} iteration ${iteration}`,
      "-m",
      `Ralph-Run: ${this.store.runId}\nRalph-Node: ${nodeId}\nRalph-Generation: ${generation}`,
    ]);
    const head = await gitHead(root);
    await git(this.projectRoot, [
      "update-ref",
      `refs/ralph/${this.store.runId}/${safeId(nodeId)}-${generation}`,
      head,
    ]);
    return head;
  }
}

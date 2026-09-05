import { spawn } from "node:child_process";
import { git } from "./manager.js";
import { RalphError } from "../util.js";

/** Hold Git's HEAD and target ref locks across the guarded worktree update. */
export async function commitDelivery(
  root: string,
  branch: string,
  base: string,
  result: string,
): Promise<void> {
  await git(root, ["check-ref-format", `refs/heads/${branch}`]);
  if (!/^[a-f0-9]{40,64}$/.test(base) || !/^[a-f0-9]{40,64}$/.test(result))
    throw new RalphError("Invalid delivery commit", "integration_pending", 10);
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<void> | undefined;
  try {
    child = spawn("git", ["update-ref", "--stdin"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const proc = child;
    let failure = "",
      preparedResolve!: () => void,
      preparedReject!: (e: Error) => void;
    const prepared = new Promise<void>((res, rej) => {
      preparedResolve = res;
      preparedReject = rej;
    });
    let output = "";
    proc.stdout!.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("prepare: ok")) preparedResolve();
    });
    proc.stderr!.on("data", (chunk) => {
      failure += chunk.toString();
    });
    proc.stdin!.on("error", () => {});
    closed = new Promise<void>((res, rej) => {
      proc.once("error", (e) => {
        preparedReject(e);
        rej(e);
      });
      proc.once("close", (code) => {
        if (code === 0) res();
        else {
          const error = new RalphError(
            failure || "Git delivery transaction interrupted",
            "integration_pending",
            10,
          );
          preparedReject(error);
          rej(error);
        }
      });
    });
    void closed.catch(() => {});
    const timer = setTimeout(() => {
      preparedReject(new Error("Git reference lock timeout"));
      proc.kill();
    }, 10000);
    try {
      proc.stdin!.write(`start\nupdate HEAD ${result} ${base}\nprepare\n`);
      await prepared;
      if (
        (await git(root, ["symbolic-ref", "--short", "HEAD"])) !== branch ||
        (await git(root, ["rev-parse", "HEAD"])) !== base ||
        (await git(root, ["status", "--porcelain"])).trim()
      )
        throw new RalphError(
          "User workspace changed before delivery lock",
          "integration_pending",
          10,
        );

      // Two-tree checkout refuses conflicting worktree edits; it never forces a reset.
      await git(root, ["read-tree", "-m", "-u", base, result]);
      if ((await git(root, ["diff", "--name-only", result, "--"])).trim())
        throw new RalphError(
          "Files changed during delivery; inspect retained worktree",
          "integration_pending",
          10,
        );
      proc.stdin!.end("commit\n");
      await closed;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    if (child && child.exitCode === null) {
      child.stdin?.end("abort\n");
      child.kill();
    }
    await closed?.catch(() => {});
  }
}

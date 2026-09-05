import { commitDelivery } from "./transaction.js";
import { git } from "./manager.js";
import { gitHead, gitBranch, gitStatus } from "../git.js";
import { RalphError } from "../util.js";
import { readFile } from "node:fs/promises";
import { durableWrite } from "../storage/journal.js";
export async function deliverResult(
  projectRoot: string,
  workspace: string,
  baseHead: string,
  baseBranch: string,
  runId: string,
  receiptPath?: string,
): Promise<string> {
  const tree = await git(workspace, ["write-tree"]);
  let commit: string | undefined;
  if (receiptPath)
    try {
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      if (
        receipt.tree !== tree ||
        receipt.baseHead !== baseHead ||
        receipt.baseBranch !== baseBranch
      )
        throw new RalphError(
          "Delivery receipt input changed",
          "integration_pending",
          10,
        );
      commit = receipt.commit;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  if (!commit) {
    commit = await git(projectRoot, [
      "-c",
      "user.name=Ralph",
      "-c",
      "user.email=ralph@localhost",
      "commit-tree",
      tree,
      "-p",
      baseHead,
      "-m",
      `feat(ralph): validated graph result\n\nRalph-Run: ${runId}\nRalph-Verdict: pass`,
    ]);
    if (receiptPath)
      await durableWrite(
        receiptPath,
        JSON.stringify({ commit, tree, baseHead, baseBranch }),
      );
  }
  await git(projectRoot, [
    "update-ref",
    `refs/heads/ralph/result-${runId}`,
    commit,
  ]);
  if (
    (await gitHead(projectRoot)) === commit &&
    (await gitBranch(projectRoot)) === baseBranch &&
    !(await gitStatus(projectRoot)).trim()
  )
    return commit;
  if (
    (await gitHead(projectRoot)) !== baseHead ||
    (await gitBranch(projectRoot)) !== baseBranch ||
    (await gitStatus(projectRoot)).trim()
  )
    throw new RalphError(
      `User workspace changed; result preserved on ralph/result-${runId}`,
      "integration_pending",
      10,
    );
  await commitDelivery(projectRoot, baseBranch, baseHead, commit);
  if (
    (await gitHead(projectRoot)) !== commit ||
    (await gitBranch(projectRoot)) !== baseBranch
  )
    throw new RalphError(
      "Delivery state changed concurrently",
      "integration_pending",
      10,
    );
  return commit;
}

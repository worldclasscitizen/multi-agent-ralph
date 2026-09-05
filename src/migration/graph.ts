import { readdir, readFile, mkdir, copyFile, cp, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadContract, statePaths } from "../state.js";
import { durableWrite } from "../storage/journal.js";
import { digest } from "../graph/schema.js";
export async function migrateGraphState(projectRoot: string, dryRun = true) {
  const paths = await statePaths(projectRoot);
  const runs = [];
  for (const id of await readdir(paths.runs).catch(() => [])) {
    try {
      const state = JSON.parse(
        await readFile(join(paths.runs, id, "state.json"), "utf8"),
      );
      runs.push({
        runId: id,
        status: state.status,
        action:
          state.status === "pass" ? "read_only_history" : "new_plan_required",
        lastCheckpoint: state.lastCheckpoint ?? null,
        contractId: state.contractId,
        stateDigest: digest(state),
      });
    } catch {
      /* Graph runs use their journal. */
    }
  }
  const source = JSON.parse(await readFile(paths.config, "utf8"));
  const id = digest({ source, runs });
  const manifest = {
    schemaVersion: 1,
    target: "0.3",
    id,
    runs,
    settingsPreserved: [
      "connections",
      "routes",
      "routePolicies",
      "verification",
    ],
    sourceDeleted: false,
  };
  if (!dryRun) {
    const dir = join(paths.root, "migration", "v0.3", id);
    await mkdir(dir, { recursive: true });
    await copyFile(paths.config, join(dir, "config-v1.json"));
    for (const run of runs) {
      const backup = join(dir, "runs", run.runId);
      try {
        await stat(backup);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        await cp(join(paths.runs, run.runId), backup, {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      }
      if (run.contractId) {
        const contract = await loadContract(projectRoot, run.contractId);
        await durableWrite(
          join(dir, "contracts", `${run.contractId}.json`),
          JSON.stringify(contract),
        );
      }
    }
    await durableWrite(join(dir, "manifest.json"), JSON.stringify(manifest));
  }
  return { ...manifest, dryRun };
}

export async function legacyPlanInput(projectRoot: string, runId: string) {
  const { safeId } = await import("../graph/schema.js");
  const { RalphError } = await import("../util.js");
  const paths = await statePaths(projectRoot);
  const state = JSON.parse(
    await readFile(join(paths.runs, safeId(runId), "state.json"), "utf8"),
  );
  if (state.status === "running")
    throw new RalphError(
      "Recover the old execution before migration",
      "migration_required",
      10,
    );
  const original = await loadContract(projectRoot, state.contractId);
  const { approvedHash, approvedAt, ...contract } = original;
  return {
    contract,
    originRunId: runId,
    request: `${contract.goal}\nContinue legacy run ${runId}. Revalidate all acceptance criteria against the current clean project.`,
  };
}

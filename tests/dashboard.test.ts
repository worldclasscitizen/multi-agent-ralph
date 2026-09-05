import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startDashboard } from "../src/dashboard.js";
import { saveConfig, saveContract, saveRun } from "../src/state.js";
import type { ProjectConfig, RunState, TaskContract } from "../src/types.js";
import { runCommand } from "../src/util.js";

describe("local dashboard", () => {
  it("serves a project-scoped snapshot and UI", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-dashboard-"));
    await runCommand("git", ["init"], { cwd: root });
    await writeFile(join(root, "README.md"), "# fixture\n");
    const routes = Object.fromEntries(
      [
        "planning_architecture",
        "frontend_visual",
        "backend_core",
        "tdd_debugging",
        "static_review",
        "delivery_evidence",
        "contractPlanner",
        "critic",
        "metaPrompter",
        "worker",
        "adjudicator",
      ].map((key) => [key, []]),
    ) as ProjectConfig["routes"];
    const config: ProjectConfig = {
      schemaVersion: 1,
      projectRoot: root,
      preset: "balanced",
      initializedAt: new Date().toISOString(),
      connections: [],
      routes,
      overrides: {},
      verifierCommands: ["git diff --check"],
      catalogVersion: 1,
    };
    const contract: TaskContract = {
      id: "contract-test",
      taskType: "backend_core",
      goal: "Dashboard fixture",
      include: [],
      exclude: [],
      requirements: [],
      acceptanceCriteria: ["visible"],
      verifierCommands: [],
      requiredArtifacts: [],
      attachments: [],
      constraints: [],
      executionProfile: "balanced",
      projectRoot: root,
    };
    const run: RunState = {
      id: "run-test",
      projectRoot: root,
      contractId: contract.id,
      taskType: contract.taskType,
      status: "pass",
      iteration: 1,
      maxIterations: 6,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      pid: process.pid,
      catalogVersion: 1,
      routes,
    };
    await saveConfig(root, config);
    await saveContract(root, contract);
    await saveRun(root, run);
    const dashboard = await startDashboard(root, { port: 0 });
    try {
      const page = await fetch(dashboard.url).then((response) =>
        response.text(),
      );
      expect(page).toContain("Graph Control Center");
      const snapshot = (await fetch(`${dashboard.url}api/snapshot`).then(
        (response) => response.json(),
      )) as { projectRoot: string; selected: { id: string } };
      expect(snapshot.projectRoot).toBe(root);
      expect(snapshot.selected.id).toBe("run-test");
    } finally {
      await new Promise<void>((resolvePromise) =>
        dashboard.server.close(() => resolvePromise()),
      );
    }
  });
});

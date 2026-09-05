import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import { approveContract, validateContract } from "../src/contracts.js";
import { draftContract, executeContract } from "../src/orchestrator.js";
import { saveConfig } from "../src/state.js";
import type { ProjectConfig, RouteEntry } from "../src/types.js";
import { runCommand } from "../src/util.js";

describe("orchestration state machine", () => {
  it("uses an independent contract critic before returning a draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-draft-"));
    await runCommand("git", ["init"], { cwd: root });
    const fixture = resolve("tests/fixtures/mock-agent.mjs");
    const route: RouteEntry = {
      connectionId: "mock:process",
      provider: "mock",
      modelId: "mock-1",
      displayName: "Mock Agent",
      reasoningEffort: "high",
      score: 100,
      source: "override",
    };
    const routes = Object.fromEntries(
      [
        "planning_architecture",
        "frontend_visual",
        "backend_core",
        "tdd_debugging",
        "static_review",
        "delivery_evidence",
        "contractPlanner",
        "router",
        "critic",
        "metaPrompter",
        "worker",
        "adjudicator",
      ].map((key) => [key, [route]]),
    ) as ProjectConfig["routes"];
    await saveConfig(root, {
      schemaVersion: 1,
      projectRoot: root,
      preset: "balanced",
      initializedAt: new Date().toISOString(),
      connections: [
        {
          id: "mock:process",
          adapter: "generic-process",
          provider: "mock",
          enabled: true,
          mode: "process",
          command: [process.execPath, fixture],
        },
      ],
      routes,
      overrides: {},
      verifierCommands: ["git diff --check"],
      catalogVersion: 2,
    });
    const contract = await draftContract(root, "Create a smoke artifact");
    expect(contract.goal).toBe("Create a smoke artifact");
    expect(contract.riskTier).toBe("T1");
  });

  it("requires a new graph approval for v0.2 contracts", async () => {
    await expect(
      executeContract("unused", {} as import("../src/types.js").TaskContract),
    ).rejects.toThrow("v0.2 approvals");
  });
});

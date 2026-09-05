import { it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  assertReleaseSchema,
  VerificationReportSchema,
  ReleaseManifestSchema,
  LiveTestBudgetSchema,
  ProviderVerificationSchema,
} from "../src/release/schema.js";
import { loadCatalog, verifyCatalog, validateCatalog } from "../src/catalog.js";
// @ts-ignore release orchestration deliberately stays outside the consumer runtime
import {
  registryState,
  coverageChecks,
  validateReports,
  atomicJson,
  sha256,
  BASELINE,
  CRITICAL,
  FUNCTIONAL_CHECKS,
  selectReports,
  verifyManifest,
} from "../scripts/lib/release.mjs";
// @ts-ignore release-only script
import { LiveBudget } from "../scripts/lib/live-budget.mjs";
import { providerVerification } from "../src/providers/verification.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
// @ts-ignore release-only script
import {
  assertLiveCampaignReady,
  assertFunctionalPreflight,
} from "../scripts/lib/live-preflight.mjs";
// @ts-ignore release-only evidence verification
import {
  PROVIDER_CHECKS,
  createEvidenceReuse,
  verifyEvidenceReuse,
} from "../scripts/lib/evidence-reuse.mjs";
// @ts-ignore release-only fixture shared by baseline and candidate
import {
  fixture,
  solutions,
  graphFor,
  task,
} from "../scripts/live-fixture.mjs";

const hash = "a".repeat(64);
const subject = {
  version: "0.3.0",
  sourceCommit: "b".repeat(40),
  sourceTree: "c".repeat(40),
  runtimeDigest: hash,
  dependencyDigest: hash,
  testDigest: hash,
};
const coverage = {
  total: { lines: { pct: 58 }, branches: { pct: 74 } },
  ...Object.fromEntries(
    CRITICAL.map((f: string) => [
      `/repo/src/${f}`,
      { lines: { pct: 99 }, branches: { pct: 99 } },
    ]),
  ),
};
const row = (kind: string, platform = "linux", node = "v24.11.1") => ({
  schemaVersion: 2,
  kind,
  subject: { ...subject },
  checkedAt: new Date().toISOString(),
  runner: { platform, node, workflowRunId: "123" },
  status: "pass",
  checks: [{ name: "required", passed: true }],
  details: {} as Record<string, any>,
});
function reports() {
  const rows = ["win32", "darwin", "linux"].flatMap((os) =>
    [22, 24].map((n) => row("ci", os, `v${n}.1.0`)),
  );
  for (const kind of [
    "coverage",
    "accessibility",
    "provider",
    "end_to_end",
    "catalog",
  ])
    rows.push(row(kind));
  for (const os of ["win32", "darwin", "linux"])
    rows.push({
      ...row("operational", os),
      details: { repetitions: 5, boundaries: ["a", "b", "c", "d", "e"] },
    });
  rows.find((r) => r.kind === "coverage")!.details.coverage = coverage;
  rows.find((r) => r.kind === "accessibility")!.details = {
    maxNodes: 32,
    revisions: 8,
    logLines: 100000,
  };
  const provider = rows.find((r) => r.kind === "provider")!;
  provider.details = { model: "fixture", cliVersion: "fixture-v1" };
  provider.checks = PROVIDER_CHECKS.map((name: string) => ({
    name,
    passed: true,
  }));
  const functional = rows.find((r) => r.kind === "end_to_end")!;
  functional.checks = FUNCTIONAL_CHECKS.map((name: string) => ({
    name,
    passed: true,
  }));
  functional.details = {
    mode: "live",
    status: "completed",
    runId: "run-fixture",
    resultHead: "1".repeat(40),
    model: "fixture",
    cliVersion: "1",
    workerCount: 2,
    injectedContract: false,
    injectedGraph: false,
    allowance: {
      schemaVersion: 1,
      releaseId: "ralph-0.3.0",
      maxCalls: 24,
      maxActiveMs: 1800000,
      apiSpendUsd: 0,
      calls: 23,
      activeMs: 1000,
      pending: null,
      attempts: [],
    },
  };
  return rows;
}
it("requires a complete, matching evidence matrix instead of boolean release gates", () => {
  const valid = reports();
  expect(() => validateReports(valid, subject)).not.toThrow();
  expect(() =>
    validateReports(
      valid.filter((r: any) => r.runner.platform !== "win32"),
      subject,
    ),
  ).toThrow(/Missing/);
  expect(() =>
    validateReports([{ gates: { allPlatforms: true } }], subject),
  ).toThrow(/Invalid release evidence/);
  valid[0]!.subject.runtimeDigest = "d".repeat(64);
  expect(() => validateReports(valid, subject)).toThrow(/subject mismatch/);
});
it("rejects stale, incomplete and substituted functional evidence", () => {
  for (const change of [
    (rows: any[]) => (rows[0].checkedAt = "2020-01-01T00:00:00Z"),
    (rows: any[]) => (rows[0].status = "fail"),
    (rows: any[]) =>
      (rows.find((r) => r.kind === "end_to_end").details.mode = "mock"),
    (rows: any[]) =>
      (rows.find((r) => r.kind === "end_to_end").details.injectedGraph = true),
    (rows: any[]) => rows.find((r) => r.kind === "end_to_end").checks.pop(),
    (rows: any[]) => (rows.find((r) => r.kind === "provider").details = {}),
    (rows: any[]) =>
      (rows.find((r) => r.kind === "coverage").details.coverage = {
        total: { lines: { pct: 1 }, branches: { pct: 1 } },
      }),
  ]) {
    const r = reports();
    change(r);
    expect(() => validateReports(r, subject)).toThrow();
  }
});
it("validates all public release contracts and rejects unknown fields", () => {
  assertReleaseSchema(VerificationReportSchema, row("ci"));
  const manifest = {
    schemaVersion: 1,
    releaseId: "ralph-0.3.0",
    subject,
    artifact: { file: "p.tgz", integrity: "sha512-x", sha256: hash },
    reports: [],
    createdAt: new Date().toISOString(),
  };
  assertReleaseSchema(ReleaseManifestSchema, manifest);
  assertReleaseSchema(ProviderVerificationSchema, {
    schemaVersion: 1,
    adapter: "codex-builtin",
    model: "fixture",
    cliVersion: "1",
    platform: "linux",
    node: "v24.0.0",
    checkedAt: new Date().toISOString(),
    runtimeDigest: hash,
    testDigest: hash,
    reportDigest: hash,
    features: [],
    support: "verified",
  });
  expect(() =>
    assertReleaseSchema(ReleaseManifestSchema, { ...manifest, publish: true }),
  ).toThrow();
});
it("persists shared live budgets and counts failed calls", async () => {
  const path = join(
      await mkdtemp(join(tmpdir(), "ralph-budget-")),
      "budget.json",
    ),
    budget = new LiveBudget(path);
  await expect(
    budget.invoke("failure", async () => {
      throw new Error("request failed");
    }),
  ).rejects.toThrow("request failed");
  const state = await new LiveBudget(path).load();
  assertReleaseSchema(LiveTestBudgetSchema, state);
  expect(state.calls).toBe(1);
  expect(state.attempts[0].outcome).toBe("failed");
  state.calls = 24;
  await atomicJson(path, state);
  await expect(budget.invoke("extra", async () => null)).rejects.toThrow(
    /exhausted/,
  );
  state.calls = 1;
  state.pending = {
    attemptId: "unknown",
    startedAt: Date.now(),
    reservedMs: 90_000,
  };
  await atomicJson(path, state);
  await expect(budget.invoke("duplicate", async () => null)).rejects.toThrow(
    /Unconfirmed/,
  );
});
it("enforces the active time ceiling and ownership of an allowance", async () => {
  const path = join(
      await mkdtemp(join(tmpdir(), "ralph-budget-")),
      "budget.json",
    ),
    budget = new LiveBudget(path);
  const state = await budget.load();
  state.activeMs = 1800000;
  await atomicJson(path, state);
  await expect(budget.invoke("extra", async () => null)).rejects.toThrow(
    /exhausted/,
  );
  await expect(new LiveBudget(path, "another-release").load()).rejects.toThrow(
    /another release/,
  );
});
it("distinguishes absent, identical, conflicting and unauthorized registry states", async () => {
  expect(
    await registryState(
      "p",
      "0.3.0",
      "hash",
      async () => new Response("", { status: 404 }),
    ),
  ).toBe("absent");
  expect(
    await registryState("p", "0.3.0", "hash", async () =>
      Response.json({ dist: { integrity: "hash" } }),
    ),
  ).toBe("identical");
  await expect(
    registryState("p", "0.3.0", "hash", async () =>
      Response.json({ dist: { integrity: "other" } }),
    ),
  ).rejects.toThrow(/different artifact/);
  await expect(
    registryState(
      "p",
      "0.3.0",
      "hash",
      async () => new Response("", { status: 401 }),
    ),
  ).rejects.toThrow(/401/);
});
it("keeps old signatures valid while rejecting tampered v2 catalogs", async () => {
  const old = JSON.parse(await readFile("assets/catalog.json", "utf8"));
  expect(verifyCatalog(old, await readFile("assets/catalog.sig", "utf8"))).toBe(
    true,
  );
  const current = await loadCatalog();
  expect(
    current.models.every(
      (m) => m.qualityTier === "unrated" && m.capabilities.reasoning === null,
    ),
  ).toBe(true);
  current.models[0]!.displayName += "tampered";
  expect(
    verifyCatalog(current, await readFile("assets/catalog-v2.sig", "utf8")),
  ).toBe(false);
  current.keyId = "unknown";
  expect(() => validateCatalog(current)).toThrow(/signing key/);
  expect(coverageChecks(coverage).every((c: any) => c.passed)).toBe(true);
});
it("does not fabricate live verification for an untested adapter", async () => {
  expect(await providerVerification("unknown", "1")).toEqual([]);
});
it("blocks unaffordable campaigns before spending and never discards a failed trial", () => {
  const mock = [4, 5, 4, 5].map((calls) => ({ calls, passed: true }));
  const allowance = {
    calls: 0,
    maxCalls: 24,
    activeMs: 0,
    maxActiveMs: 1800000,
    pending: null,
  };
  expect(assertLiveCampaignReady(allowance, [], mock, true)).toEqual({
    minimumCalls: 22,
    remainingCalls: 24,
    retryReserve: 2,
  });
  expect(() =>
    assertLiveCampaignReady({ ...allowance, calls: 15 }, [], mock, false),
  ).toThrow(/18 calls required, 9 available/);
  expect(() =>
    assertLiveCampaignReady(allowance, [{ passed: false }], mock, false),
  ).toThrow(/prior comparison failed/);
  expect(() =>
    assertLiveCampaignReady({ ...allowance, pending: {} }, [], mock, false),
  ).toThrow(/Unconfirmed/);
  expect(() =>
    assertLiveCampaignReady(allowance, [], mock.slice(1), true),
  ).toThrow(/Four/);
  expect(() =>
    assertLiveCampaignReady(
      { ...allowance, activeMs: 1800000 },
      [],
      mock,
      true,
    ),
  ).toThrow(/time/);
});
it("records behavioral evidence per branch without requiring an unfinished sibling", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-acceptance-"));
  await fixture(root);
  const exec = promisify(execFile);
  const check = (file: string) =>
    exec(process.execPath, ["--test", file], { cwd: root, windowsHide: true });
  await expect(check("left.test.mjs")).rejects.toThrow();
  await writeFile(join(root, "left.mjs"), solutions["left.mjs"]);
  await expect(check("left.test.mjs")).resolves.toBeDefined();
  await expect(check("right.test.mjs")).rejects.toThrow();
  await writeFile(join(root, "right.mjs"), solutions["right.mjs"]);
  await expect(check("right.test.mjs")).resolves.toBeDefined();
  await expect(
    exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { oracle } from './scripts/live-fixture.mjs'; await oracle(process.argv[1]);",
        root,
      ],
      { windowsHide: true },
    ),
  ).resolves.toBeDefined();
  const graph = graphFor(task);
  expect(
    graph.nodes.find((n: any) => n.nodeId === "left").verifierIds,
  ).toContain("node --test left.test.mjs");
  expect(
    graph.nodes.find((n: any) => n.nodeId === "left").verifierIds,
  ).not.toContain("node --test right.test.mjs");
  expect(
    graph.nodes.find((n: any) => n.kind === "validate").verifierIds,
  ).toEqual(task.verifierCommands);
  await writeFile(
    join(root, "left.mjs"),
    "export function sumNonNegative() { return 0; }\n",
  );
  await expect(check("left.test.mjs")).rejects.toThrow();
});
it("requires an affordable generated-graph mock before the remaining real calls", () => {
  const allowance = {
    maxCalls: 24,
    calls: 15,
    pending: null,
    activeMs: 480712,
    maxActiveMs: 1800000,
  };
  const mock = {
    mode: "mock",
    passed: true,
    status: "completed",
    workerCount: 2,
    calls: 8,
  };
  expect(assertFunctionalPreflight(allowance, mock)).toEqual({
    estimatedCalls: 8,
    remainingCalls: 9,
    retryReserve: 1,
  });
  for (const bad of [
    { ...mock, mode: "live" },
    { ...mock, passed: false },
    { ...mock, calls: 5 },
    { ...mock, workerCount: 1 },
  ])
    expect(() => assertFunctionalPreflight(allowance, bad)).toThrow();
  for (const bad of [
    { ...allowance, calls: 17 },
    { ...allowance, pending: {} },
    { ...allowance, activeMs: 1800000 },
  ])
    expect(() => assertFunctionalPreflight(bad, mock)).toThrow();
});
it("preserves historical comparisons without allowing required evidence to become optional", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ralph-manifest-"));
  const rows = reports().map((value, i) => ({
    file: `report-${i}.json`,
    value,
  }));
  rows.push({
    file: "old-comparison.json",
    value: { ...row("comparison"), status: "fail" },
  });
  const selected = selectReports(rows);
  expect(selected.references.map((r: any) => r.file)).toEqual([
    "old-comparison.json",
  ]);
  expect(() =>
    validateReports(
      selected.required.map((r: any) => r.value),
      subject,
    ),
  ).not.toThrow();
  const archive = join(directory, "package.tgz"),
    bytes = Buffer.from("same tested archive");
  await writeFile(archive, bytes);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  for (const r of rows) {
    if (r.value.kind === "ci") r.value.details.artifactIntegrity = integrity;
    await atomicJson(join(directory, r.file), r.value);
  }
  const refs = async (list: any[]) =>
    Promise.all(
      list.map(async (r) => ({
        file: r.file,
        sha256: sha256(await readFile(join(directory, r.file))),
      })),
    );
  const manifest = {
    schemaVersion: 2,
    gateProfile: "stable-functional-v1",
    releaseId: "ralph-0.3.0",
    subject,
    artifact: { file: "package.tgz", integrity, sha256: sha256(bytes) },
    reports: await refs(selected.required),
    references: await refs(selected.references),
    createdAt: new Date().toISOString(),
  };
  await expect(
    verifyManifest(manifest, archive, directory, subject),
  ).resolves.toBe(true);
  await expect(
    verifyManifest(
      {
        ...manifest,
        references: [...manifest.references, manifest.reports[0]],
        reports: manifest.reports.slice(1),
      },
      archive,
      directory,
      subject,
    ),
  ).rejects.toThrow(/relabeled/);
  await writeFile(join(directory, rows[0]!.file), "{}");
  await expect(
    verifyManifest(manifest, archive, directory, subject),
  ).rejects.toThrow(/integrity/);
});
it("proves provider reuse from source bytes and preserves the original date, result and environment", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-reuse-")),
    exec = promisify(execFile);
  const git = (...args: string[]) =>
    exec("git", args, { cwd: root, windowsHide: true });
  await mkdir(join(root, "src/providers"), { recursive: true });
  await mkdir(join(root, "src/workspace"), { recursive: true });
  await mkdir(join(root, "scripts/lib"), { recursive: true });
  await writeFile(
    join(root, "src/workspace/manager.ts"),
    "export const fixture = 1;\n",
  );
  await writeFile(
    join(root, "scripts/provider-conformance.mjs"),
    "// frozen requests\n",
  );
  await writeFile(
    join(root, "scripts/lib/live-budget.mjs"),
    "// frozen allowance\n",
  );
  await writeFile(join(root, "package-lock.json"), "{}\n");
  await writeFile(
    join(root, "src/providers/cli.ts"),
    "export const protocol = 1;\n",
  );
  await git("init");
  await git("config", "user.name", "Evidence");
  await git("config", "user.email", "evidence@localhost");
  await git("add", ".");
  await git("commit", "-m", "Original protocol");
  const original = {
    ...row("provider"),
    schemaVersion: 1,
    checks: PROVIDER_CHECKS.map((name: string) => ({ name, passed: true })),
    details: { adapter: "codex-builtin", model: "fixture", cliVersion: "1" },
  };
  original.subject.sourceCommit = (
    await git("rev-parse", "HEAD")
  ).stdout.trim();
  const path = join(root, "original.json");
  await atomicJson(path, original);
  const observed = {
    ...original.details,
    platform: original.runner.platform,
    node: original.runner.node,
  };
  const reuse = await createEvidenceReuse(root, path, observed);
  const current = { ...original, schemaVersion: 2, reuse };
  await writeFile(join(root, "README.md"), "Documentation changed\n");
  await writeFile(
    join(root, "src/prompts.ts"),
    "// Unrelated planner prompt changed\n",
  );
  await expect(
    verifyEvidenceReuse(current, root, root),
  ).resolves.toBeUndefined();
  await expect(
    verifyEvidenceReuse({ ...current, checkedAt: "2027-01-01" }, root, root),
  ).rejects.toThrow(/original/);
  await expect(
    createEvidenceReuse(root, path, { ...observed, model: "different" }),
  ).rejects.toThrow(/environment/);
  const tampered = structuredClone(current);
  tampered.reuse.sourceFiles[0].sha256 = hash;
  await expect(verifyEvidenceReuse(tampered, root, root)).rejects.toThrow(
    /identity/,
  );
  await writeFile(
    join(root, "src/providers/cli.ts"),
    "export const protocol = 2;\n",
  );
  await expect(verifyEvidenceReuse(current, root, root)).rejects.toThrow(
    /identity/,
  );
  await expect(createEvidenceReuse(root, path, observed)).rejects.toThrow(
    /changed/,
  );
  await atomicJson(path, { ...original, status: "fail" });
  await expect(createEvidenceReuse(root, path, observed)).rejects.toThrow(
    /passing/,
  );
  await expect(verifyEvidenceReuse(current, root, root)).rejects.toThrow(
    /integrity/,
  );
});

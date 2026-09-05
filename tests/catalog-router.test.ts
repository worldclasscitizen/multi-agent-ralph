import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadCatalog,
  catalogStatus,
  validateCatalog,
  updateCatalog,
  catalogDiff,
  previewCatalogUpdate,
  maybeRefreshCatalog,
} from "../src/catalog.js";
import { buildRoutes } from "../src/router.js";
import type { ConnectionConfig } from "../src/types.js";

describe("signed catalog and deterministic router", () => {
  it("rejects malformed metadata, invented scores and expired measurement windows", async () => {
    const original = await loadCatalog();
    const changes: Array<(c: any) => void> = [
      (c) => (c.schemaVersion = 3),
      (c) => (c.version = 0),
      (c) => (c.generatedAt = "invalid"),
      (c) => (c.models = {}),
      (c) => c.models.push(c.models[0]),
      (c) => (c.models[0].provider = ""),
      (c) => (c.models[0].checkedAt = "bad"),
      (c) => (c.models[0].expiresAt = "bad"),
      (c) => (c.models[0].expiresAt = "2028-01-01"),
      (c) => (c.models[0].expiresAt = "2020-01-01"),
      (c) => (c.models[0].capabilities.coding = 101),
      (c) => (c.models[0].qualityTier = "measured"),
      (c) => (c.models[0].capabilities.vision = "yes"),
      (c) => (c.models[0].costTier = 0),
      (c) => (c.models[0].latencyTier = 6),
      (c) => (c.models[0].supportedEfforts = []),
      (c) => (c.models[0].supportedEfforts = [1]),
      (c) => (c.models[0].recommendedEffort = "unknown"),
      (c) => (c.models[0].evidence = []),
      (c) => (c.models[0].evidence[0].source = ""),
      (c) => (c.models[0].evidence[0].checkedAt = "invalid"),
    ];
    for (const change of changes) {
      const candidate = structuredClone(original);
      change(candidate);
      expect(() => validateCatalog(candidate)).toThrow();
    }
  });

  it("isolates the v2 cache and validates remote signatures before caching", async () => {
    const catalog = JSON.parse(
      await readFile("assets/catalog-v2.json", "utf8"),
    );
    const signature = await readFile("assets/catalog-v2.sig", "utf8");
    vi.stubEnv(
      "XDG_CACHE_HOME",
      await mkdtemp(join(tmpdir(), "ralph-catalog-v2-")),
    );
    let mode = "valid";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith(".sig"))
          return new Response(mode === "bad-signature" ? "bad" : signature);
        if (mode === "unchanged") return new Response(null, { status: 304 });
        if (mode === "error") return new Response(null, { status: 503 });
        if (mode === "oversized") return new Response("x".repeat(500001));
        if (mode === "legacy")
          return Response.json(
            JSON.parse(await readFile("assets/catalog.json", "utf8")),
          );
        return Response.json(catalog, { headers: { etag: "v2-fixture" } });
      }),
    );
    try {
      for (const rejected of [
        "bad-signature",
        "error",
        "oversized",
        "legacy",
      ]) {
        mode = rejected;
        await expect(updateCatalog()).rejects.toThrow();
      }
      mode = "valid";
      expect((await updateCatalog()).version).toBe(3);
      expect((await loadCatalog()).schemaVersion).toBe(2);
      const status = await catalogStatus({ checkRemote: true });
      expect(status.cacheVersion).toBe(3);
      expect(status.changes).toEqual({ added: [], removed: [], modified: [] });
      expect(await catalogDiff()).toMatchObject({ from: 3, to: 3 });
      expect(await previewCatalogUpdate()).toBeUndefined();
      mode = "unchanged";
      expect((await updateCatalog()).version).toBe(3);
      expect((await catalogStatus({ checkRemote: true })).remoteChecked).toBe(
        true,
      );
      await maybeRefreshCatalog();
      mode = "error";
      expect((await catalogStatus({ checkRemote: true })).remoteChecked).toBe(
        false,
      );
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
  it("verifies and loads the signed bootstrap catalog", async () => {
    const catalog = await loadCatalog();
    const status = await catalogStatus({ offline: true });
    expect(catalog.version).toBe(3);
    expect(catalog.schemaVersion).toBe(2);
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(status.signatureValid).toBe(true);
  });

  it("keeps unrated routes deterministic without invented speed preferences", async () => {
    const catalog = await loadCatalog();
    const connections: ConnectionConfig[] = [
      {
        id: "openai:codex-login",
        adapter: "codex-builtin",
        provider: "openai",
        enabled: true,
        mode: "builtin",
      },
      {
        id: "anthropic:claude-login",
        adapter: "claude-code-builtin",
        provider: "anthropic",
        enabled: true,
        mode: "builtin",
      },
      {
        id: "google:antigravity-login",
        adapter: "antigravity-builtin",
        provider: "google",
        enabled: true,
        mode: "builtin",
      },
    ];
    const first = buildRoutes(catalog, connections, "balanced");
    const second = buildRoutes(catalog, connections, "balanced");
    expect(first).toEqual(second);
    expect(
      new Set(first.backend_core.map((item) => item.provider)).size,
    ).toBeGreaterThan(1);
    const fast = buildRoutes(catalog, connections, "fast");
    expect(fast.frontend_visual).toEqual(first.frontend_visual);
    expect(
      fast.frontend_visual.every((r) =>
        r.degradedCapabilities?.includes("unrated_model"),
      ),
    ).toBe(true);
  });

  it("keeps a non-vision fallback with an explicit degradation marker", async () => {
    const catalog = await loadCatalog();
    const connections: ConnectionConfig[] = [
      {
        id: "deepseek:api",
        adapter: "deepseek-api",
        provider: "deepseek",
        enabled: true,
        mode: "api",
      },
    ];
    const routes = buildRoutes(catalog, connections, "balanced");
    expect(routes.frontend_visual).toHaveLength(1);
    expect(routes.frontend_visual[0]?.modelId).toBe("deepseek-v4-pro");
    expect(routes.frontend_visual[0]?.degradedCapabilities).toContain("vision");
  });
});

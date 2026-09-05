import { createPublicKey, verify } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelCatalog } from "./types.js";
import { atomicWrite, readJson, writeJson } from "./util.js";

const ASSET_ROOT = fileURLToPath(new URL("../assets", import.meta.url));
const BUNDLED_CATALOG = join(ASSET_ROOT, "catalog-v2.json");
const BUNDLED_SIGNATURE = join(ASSET_ROOT, "catalog-v2.sig");
const DEFAULT_CATALOG_URL =
  "https://github.com/worldclasscitizen/Ralph/releases/latest/download/catalog-v2.json";
const DEFAULT_SIGNATURE_URL =
  "https://github.com/worldclasscitizen/Ralph/releases/latest/download/catalog-v2.sig";
const MAX_CATALOG_BYTES = 500_000;

// 릴리스 서명 전용 private key는 저장소에 두지 않습니다.
export const LEGACY_CATALOG_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA0KLCmIESWDRyjfzn0ZrOA0zKHqHGciXGDDez2eIQmVM=
-----END PUBLIC KEY-----`;
import { CATALOG_PUBLIC_KEY_PEM, CATALOG_KEY_ID } from "./catalog-key.js";
export { CATALOG_PUBLIC_KEY_PEM, CATALOG_KEY_ID };

export interface CatalogStatus {
  bundledVersion: number;
  cacheVersion?: number;
  selectedVersion: number;
  signatureValid: boolean;
  lastCheckedAt?: string;
  stale: boolean;
  remoteChecked: boolean;
  remoteVersion?: number;
  changes?: { added: string[]; removed: string[]; modified: string[] };
  message: string;
}

interface CatalogMeta {
  version: number;
  etag?: string;
  lastCheckedAt: string;
  lastCheckSucceeded?: boolean;
  lastError?: string;
}

function catalogCacheDir(): string {
  const base =
    process.env.XDG_CACHE_HOME ??
    (process.platform === "win32"
      ? process.env.LOCALAPPDATA
      : process.env.HOME
        ? join(process.env.HOME, ".cache")
        : undefined);
  if (!base) throw new Error("사용자 cache 디렉터리를 찾지 못했습니다.");
  return join(base, "ralph", "catalog-v2");
}

function canonicalBytes(catalog: ModelCatalog): Buffer {
  return Buffer.from(JSON.stringify(catalog), "utf8");
}

export function validateCatalog(catalog: ModelCatalog): void {
  if (
    ![1, 2].includes(catalog.schemaVersion) ||
    !Number.isInteger(catalog.version) ||
    catalog.version < 1
  ) {
    throw new Error("지원하지 않는 모델 카탈로그 형식입니다.");
  }
  if (catalog.schemaVersion === 2 && catalog.keyId !== CATALOG_KEY_ID)
    throw new Error("Unknown catalog signing key");
  if (!Number.isFinite(Date.parse(catalog.generatedAt)))
    throw new Error("카탈로그 생성 시각이 올바르지 않습니다.");
  if (!Array.isArray(catalog.models) || catalog.models.length > 500)
    throw new Error("모델 카탈로그 크기가 올바르지 않습니다.");
  const seen = new Set<string>();
  for (const model of catalog.models) {
    const key = `${model.adapter}:${model.modelId}`;
    if (seen.has(key)) throw new Error(`중복 모델입니다: ${key}`);
    seen.add(key);
    if (
      !model.provider ||
      !model.adapter ||
      !model.modelId ||
      !model.displayName
    )
      throw new Error("필수 모델 필드가 누락되었습니다.");
    if (
      !Number.isFinite(
        Date.parse(
          (catalog.schemaVersion === 2 ? model.checkedAt : model.releasedAt) ??
            "",
        ),
      ) ||
      !Number.isFinite(Date.parse(model.expiresAt))
    ) {
      throw new Error(`${key}의 날짜가 올바르지 않습니다.`);
    }
    const lifetime =
      Date.parse(model.expiresAt) -
      Date.parse(
        (catalog.schemaVersion === 2 ? model.checkedAt : model.releasedAt)!,
      );
    if (lifetime <= 0 || lifetime > 184 * 24 * 60 * 60 * 1000) {
      throw new Error(`${key}의 만료일이 6개월 모델 정책을 초과합니다.`);
    }
    for (const [name, score] of Object.entries({
      reasoning: model.capabilities.reasoning,
      coding: model.capabilities.coding,
      reliabilityBaseline: model.reliabilityBaseline,
      ...model.taskAffinity,
    })) {
      if (
        catalog.schemaVersion === 2 &&
        model.qualityTier === "unrated" &&
        score === null
      )
        continue;
      if (score === null || !Number.isFinite(score) || score < 0 || score > 100)
        throw new Error(`${key}의 ${name} 점수는 0~100이어야 합니다.`);
    }
    for (const name of [
      "structuredOutput",
      "vision",
      "toolUse",
      "longContext",
    ] as const) {
      if (typeof model.capabilities[name] !== "boolean")
        throw new Error(`${key}의 ${name} capability가 올바르지 않습니다.`);
    }
    if (
      !(
        catalog.schemaVersion === 2 &&
        model.qualityTier === "unrated" &&
        model.costTier === null &&
        model.latencyTier === null
      ) &&
      (!Number.isInteger(model.costTier) ||
        (model.costTier ?? 0) < 1 ||
        (model.costTier ?? 0) > 5 ||
        !Number.isInteger(model.latencyTier) ||
        (model.latencyTier ?? 0) < 1 ||
        (model.latencyTier ?? 0) > 5)
    ) {
      throw new Error(`${key}의 비용·지연 등급은 1~5여야 합니다.`);
    }
    if (
      !Array.isArray(model.supportedEfforts) ||
      !model.supportedEfforts.length ||
      !model.supportedEfforts.every((effort) => typeof effort === "string") ||
      !model.supportedEfforts.includes(model.recommendedEffort)
    ) {
      throw new Error(`${key}의 추론 강도 목록이 올바르지 않습니다.`);
    }
    if (
      !Array.isArray(model.evidence) ||
      !model.evidence.length ||
      !model.evidence.every(
        (item) =>
          typeof item.source === "string" &&
          item.source.length > 0 &&
          Number.isFinite(Date.parse(item.checkedAt)),
      )
    ) {
      throw new Error(`${key}의 근거 정보가 올바르지 않습니다.`);
    }
  }
}

export function verifyCatalog(
  catalog: ModelCatalog,
  signatureBase64: string,
): boolean {
  validateCatalog(catalog);
  try {
    return verify(
      null,
      canonicalBytes(catalog),
      createPublicKey(
        catalog.schemaVersion === 1
          ? LEGACY_CATALOG_PUBLIC_KEY_PEM
          : CATALOG_PUBLIC_KEY_PEM,
      ),
      Buffer.from(signatureBase64.trim(), "base64"),
    );
  } catch {
    return false;
  }
}

async function readBundled(): Promise<{
  catalog: ModelCatalog;
  signatureValid: boolean;
}> {
  const catalog = await readJson<ModelCatalog>(BUNDLED_CATALOG);
  validateCatalog(catalog);
  if (catalog.schemaVersion !== 2)
    throw new Error("Expected v2 catalog channel");
  let signatureValid = false;
  try {
    signatureValid = verifyCatalog(
      catalog,
      await readFile(BUNDLED_SIGNATURE, "utf8"),
    );
  } catch {
    // 개발 checkout에서는 첫 bootstrap이 서명되지 않았을 수 있습니다.
  }
  return { catalog, signatureValid };
}

async function readCache(): Promise<
  { catalog: ModelCatalog; meta: CatalogMeta } | undefined
> {
  const dir = catalogCacheDir();
  try {
    const catalog = await readJson<ModelCatalog>(join(dir, "catalog.json"));
    const signature = await readFile(join(dir, "catalog.sig"), "utf8");
    const meta = await readJson<CatalogMeta>(join(dir, "catalog-meta.json"));
    if (
      catalog.schemaVersion !== 2 ||
      meta.version !== catalog.version ||
      !verifyCatalog(catalog, signature)
    )
      return undefined;
    return { catalog, meta };
  } catch {
    return undefined;
  }
}

export async function loadCatalog(): Promise<ModelCatalog> {
  const bundled = await readBundled();
  if (!bundled.signatureValid)
    throw new Error("내장 모델 카탈로그의 Ed25519 서명이 올바르지 않습니다.");
  const cached = await readCache();
  if (cached && cached.catalog.version >= bundled.catalog.version)
    return cached.catalog;
  return bundled.catalog;
}

export async function catalogStatus(
  options: { offline?: boolean; checkRemote?: boolean } = {},
): Promise<CatalogStatus> {
  const bundled = await readBundled();
  const cached = await readCache();
  const selected =
    cached && cached.catalog.version >= bundled.catalog.version
      ? cached.catalog
      : bundled.catalog;
  const lastCheckedAt = cached?.meta.lastCheckedAt;
  const ageMs = lastCheckedAt
    ? Date.now() - Date.parse(lastCheckedAt)
    : Number.POSITIVE_INFINITY;
  const stale = ageMs > 7 * 24 * 60 * 60 * 1000;
  const status: CatalogStatus = {
    bundledVersion: bundled.catalog.version,
    ...(cached ? { cacheVersion: cached.catalog.version } : {}),
    selectedVersion: selected.version,
    signatureValid: cached ? true : bundled.signatureValid,
    ...(lastCheckedAt ? { lastCheckedAt } : {}),
    stale,
    remoteChecked: false,
    message: options.offline
      ? "오프라인 모드: 원격 변경 여부를 확인하지 못했습니다."
      : "원격 확인을 생략했습니다.",
  };
  if (options.checkRemote && !options.offline) {
    try {
      const remote = await fetchRemote(cached?.meta.etag, true);
      status.remoteChecked = true;
      status.remoteVersion = remote?.catalog.version ?? selected.version;
      if (remote) status.changes = compareCatalogs(selected, remote.catalog);
      status.message = remote
        ? "서명된 원격 카탈로그를 확인했습니다."
        : "원격 카탈로그가 변경되지 않았습니다.";
    } catch (error) {
      status.message = `원격 변경 여부를 확인하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return status;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  headers: HeadersInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRemote(
  etag?: string,
  metadataOnly = false,
): Promise<
  { catalog: ModelCatalog; signature: string; etag?: string } | undefined
> {
  const url = process.env.RALPH_CATALOG_URL ?? DEFAULT_CATALOG_URL;
  const signatureUrl =
    process.env.RALPH_CATALOG_SIGNATURE_URL ?? DEFAULT_SIGNATURE_URL;
  const startedAt = Date.now();
  const response = await fetchWithTimeout(
    url,
    1_000,
    etag ? { "If-None-Match": etag } : {},
  );
  if (response.status === 304) return undefined;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_CATALOG_BYTES)
    throw new Error("카탈로그가 500KB 상한을 초과했습니다.");
  const catalog = JSON.parse(
    Buffer.from(body).toString("utf8"),
  ) as ModelCatalog;
  validateCatalog(catalog);
  if (catalog.schemaVersion !== 2)
    throw new Error("Expected v2 catalog channel");
  const remaining = Math.max(
    1,
    Math.min(1_000, 3_000 - (Date.now() - startedAt)),
  );
  const signatureResponse = await fetchWithTimeout(signatureUrl, remaining);
  if (!signatureResponse.ok)
    throw new Error(`서명 HTTP ${signatureResponse.status}`);
  const signature = await signatureResponse.text();
  if (!verifyCatalog(catalog, signature))
    throw new Error("Ed25519 서명 검증에 실패했습니다.");
  if (metadataOnly)
    return {
      catalog,
      signature,
      ...(response.headers.get("etag")
        ? { etag: response.headers.get("etag")! }
        : {}),
    };
  return {
    catalog,
    signature,
    ...(response.headers.get("etag")
      ? { etag: response.headers.get("etag")! }
      : {}),
  };
}

export async function updateCatalog(): Promise<ModelCatalog> {
  const bundled = await readBundled();
  const cached = await readCache();
  if (!bundled.signatureValid)
    throw new Error("내장 모델 카탈로그의 Ed25519 서명이 올바르지 않습니다.");
  const current =
    cached && cached.catalog.version >= bundled.catalog.version
      ? cached.catalog
      : bundled.catalog;
  const currentVersion = current.version;
  const remote = await fetchRemote(cached?.meta.etag);
  const dir = catalogCacheDir();
  await mkdir(dir, { recursive: true });
  if (!remote) {
    if (cached)
      await writeJson(join(dir, "catalog-meta.json"), {
        ...cached.meta,
        lastCheckedAt: new Date().toISOString(),
        lastCheckSucceeded: true,
        lastError: undefined,
      });
    return cached?.catalog ?? bundled.catalog;
  }
  if (remote.catalog.version < currentVersion)
    throw new Error("카탈로그 rollback을 거부했습니다.");
  if (
    remote.catalog.version === currentVersion &&
    !canonicalBytes(remote.catalog).equals(canonicalBytes(current))
  ) {
    throw new Error(
      "동일 버전의 내용 변경을 거부했습니다. 카탈로그 버전을 올려야 합니다.",
    );
  }
  await atomicWrite(
    join(dir, "catalog.json"),
    `${JSON.stringify(remote.catalog, null, 2)}\n`,
  );
  await atomicWrite(join(dir, "catalog.sig"), `${remote.signature.trim()}\n`);
  await writeJson(join(dir, "catalog-meta.json"), {
    version: remote.catalog.version,
    ...(remote.etag ? { etag: remote.etag } : {}),
    lastCheckedAt: new Date().toISOString(),
    lastCheckSucceeded: true,
  });
  return remote.catalog;
}

async function recordFailedBackgroundCheck(error: unknown): Promise<void> {
  const bundled = await readBundled();
  if (!bundled.signatureValid) return;
  const cached = await readCache();
  const dir = catalogCacheDir();
  await mkdir(dir, { recursive: true });
  if (!cached) {
    await atomicWrite(
      join(dir, "catalog.json"),
      `${JSON.stringify(bundled.catalog, null, 2)}\n`,
    );
    await atomicWrite(
      join(dir, "catalog.sig"),
      `${(await readFile(BUNDLED_SIGNATURE, "utf8")).trim()}\n`,
    );
  }
  const selected = cached?.catalog ?? bundled.catalog;
  await writeJson(join(dir, "catalog-meta.json"), {
    version: selected.version,
    ...(cached?.meta.etag ? { etag: cached.meta.etag } : {}),
    lastCheckedAt: new Date().toISOString(),
    lastCheckSucceeded: false,
    lastError:
      error instanceof Error
        ? error.message.slice(0, 500)
        : String(error).slice(0, 500),
  });
}

export async function maybeRefreshCatalog(): Promise<void> {
  const cached = await readCache();
  const age = cached
    ? Date.now() - Date.parse(cached.meta.lastCheckedAt)
    : Number.POSITIVE_INFINITY;
  if (age <= 24 * 60 * 60 * 1000) return;
  if (age <= 7 * 24 * 60 * 60 * 1000) {
    void updateCatalog().catch((error) => recordFailedBackgroundCheck(error));
    return;
  }
  await updateCatalog().catch((error) => recordFailedBackgroundCheck(error));
}

export async function catalogDiff(): Promise<Record<string, unknown>> {
  const bundled = await readBundled();
  const cached = await readCache();
  const current = cached?.catalog ?? bundled.catalog;
  const remote = await fetchRemote();
  const target = remote?.catalog ?? current;
  return {
    from: current.version,
    to: target.version,
    ...compareCatalogs(current, target),
  };
}

export async function previewCatalogUpdate(): Promise<
  ModelCatalog | undefined
> {
  const bundled = await readBundled();
  if (!bundled.signatureValid) return undefined;
  const cached = await readCache();
  const current =
    cached && cached.catalog.version >= bundled.catalog.version
      ? cached.catalog
      : bundled.catalog;
  const remote = await fetchRemote(cached?.meta.etag);
  if (!remote || remote.catalog.version <= current.version) return undefined;
  return remote.catalog;
}

function compareCatalogs(
  base: ModelCatalog,
  target: ModelCatalog,
): { added: string[]; removed: string[]; modified: string[] } {
  const key = (model: ModelCatalog["models"][number]) =>
    `${model.adapter}:${model.modelId}`;
  const baseMap = new Map(base.models.map((model) => [key(model), model]));
  const targetMap = new Map(target.models.map((model) => [key(model), model]));
  return {
    added: [...targetMap.keys()].filter((item) => !baseMap.has(item)),
    removed: [...baseMap.keys()].filter((item) => !targetMap.has(item)),
    modified: [...targetMap.keys()].filter(
      (item) =>
        baseMap.has(item) &&
        JSON.stringify(baseMap.get(item)) !==
          JSON.stringify(targetMap.get(item)),
    ),
  };
}

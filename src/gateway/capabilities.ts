import type { ConnectionConfig, ProviderAdapter } from "../types.js";
import { providerVerification } from "../providers/verification.js";
import type { ProviderVerificationV1 } from "../release/schema.js";
export interface CapabilityReport {
  connectionId: string;
  installed: boolean;
  authentication: string;
  support: "verified" | "experimental" | "compatible" | "unavailable";
  checkedAt: string;
  version?: string;
  features: string[];
  usage: "reported" | "unknown";
  cancellation: "signal" | "unknown";
  maxConcurrency: number;
  verification?: ProviderVerificationV1[];
}
export async function probeProvider(
  connection: ConnectionConfig,
  adapter: ProviderAdapter,
): Promise<CapabilityReport> {
  const detected = await adapter.detect();
  const auth = detected.installed
    ? await adapter.authStatus()
    : { status: "unavailable" };
  const verification = await providerVerification(connection.adapter, detected.version);
  return {
    connectionId: connection.id,
    installed: detected.installed,
    authentication: auth.status,
    support: !detected.installed
      ? "unavailable"
      : connection.adapter === "antigravity-builtin"
        ? "experimental"
        : verification.some((v) => v.support === "verified") ? "verified" : "compatible",
    checkedAt: new Date().toISOString(),
    version: detected.version,
    features: [
      "text",
      "json_validation",
      ...(connection.mode === "api" ? ["tools"] : []),
    ],
    usage: "unknown",
    cancellation: "signal",
    maxConcurrency: 1,
    verification,
  };
}

import { readFile } from "node:fs/promises";
import { ProviderVerificationSchema, assertReleaseSchema, type ProviderVerificationV1 } from "../release/schema.js";

export async function providerVerification(adapter: string, version?: string): Promise<ProviderVerificationV1[]> {
  const rows = JSON.parse(await readFile(new URL("../../assets/provider-verification.json", import.meta.url), "utf8")) as unknown[];
  return rows.flatMap((row) => {
    assertReleaseSchema(ProviderVerificationSchema, row);
    const value = row as ProviderVerificationV1;
    const age = Date.now() - Date.parse(value.checkedAt);
    return value.adapter === adapter && value.cliVersion === version && value.platform === process.platform &&
      value.node.split(".")[0] === process.version.split(".")[0] && age >= 0 && age <= 30 * 86400_000 ? [value] : [];
  });
}

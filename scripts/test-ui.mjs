import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
// The suite/config are native ESM. Skip the TS transform hook, which exits silently
// on this Windows/Node 24 Unicode-path combination. TypeScript is checked in build.
const child = spawn(
  process.execPath,
  [
    fileURLToPath(
      new URL("../node_modules/@playwright/test/cli.js", import.meta.url),
    ),
    "test",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, PW_DISABLE_TS_ESM: "1" },
  },
);
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});

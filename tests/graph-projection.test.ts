import { it, expect } from "vitest";
import { projectEvent } from "../ui/src/projection.js";
import { replay } from "../src/storage/run-store.js";
import { runCommand } from "../src/util.js";
it("projects ordered updates once and rejects missing events", () => {
  const state = replay("ui", []);
  const event = {
    seq: 1,
    type: "invocation.started",
    timestamp: new Date().toISOString(),
    payload: {
      nodeId: "work",
      modelId: "model",
      connectionId: "connection",
      role: "worker",
    },
  };
  const next = projectEvent(state, event);
  expect(next.attempts).toBe(1);
  expect(projectEvent(next, event)).toBe(next);
  expect(() => projectEvent(state, { ...event, seq: 2 })).toThrow(/gap/);
  expect(state.attempts).toBe(0);
});
it("actually executes quoted verifier programs and preserves failing exit codes", async () => {
  const command = `node -e "if (2 + 2 === 4) process.exit(7)"`;
  const result = await runCommand(
    process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    process.platform === "win32"
      ? ["/d", "/s", "/c", command]
      : ["-c", command],
  );
  expect(result.exitCode).toBe(7);
});

import { open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { atomicJson, json } from "./release.mjs";
import { LiveTestBudgetSchema, assertReleaseSchema } from "../../dist/release/schema.js";

/** One persistent release allowance, shared by smoke and baseline/candidate runs. */
export class LiveBudget {
  constructor(path, releaseId = "ralph-0.3.0") { this.path = path; this.releaseId = releaseId; }
  async load() {
    let state;
    try { state = await json(this.path); }
    catch (e) {
      if (e.code !== "ENOENT") throw e;
      state = { schemaVersion: 1, releaseId: this.releaseId, maxCalls: 24, maxActiveMs: 1800000,
        apiSpendUsd: 0, calls: 0, activeMs: 0, pending: null, attempts: [] };
      await atomicJson(this.path, state);
    }
    assertReleaseSchema(LiveTestBudgetSchema, state);
    if (state.releaseId !== this.releaseId) throw new Error("Budget belongs to another release");
    return state;
  }
  async invoke(purpose, fn, outerSignal, maxMs = 90_000) {
    await this.load();
    const guard = await open(`${this.path}.lock`, "wx", 0o600);
    try {
      const state = await this.load();
      if (state.pending) throw new Error("Unconfirmed live call; inspect the retained process before further spending");
      if (state.calls >= 24 || state.activeMs >= 1800000) throw new Error("Live release test budget exhausted");
      const reservedMs = Math.min(maxMs, 1800000 - state.activeMs);
      const attemptId = randomUUID(), startedAt = Date.now();
      state.calls++;
      state.pending = { attemptId, startedAt, reservedMs };
      await atomicJson(this.path, state);
      let outcome = "failed", usage = null;
      try {
        const signal = AbortSignal.any([AbortSignal.timeout(reservedMs), ...(outerSignal ? [outerSignal] : [])]);
        const value = await fn(signal);
        usage = value?.usage ?? null;
        outcome = value?.exitCode && value.exitCode !== 0 ? "failed" : "returned";
        return value;
      } finally {
        const durationMs = Date.now() - startedAt;
        state.activeMs += durationMs;
        state.pending = null;
        state.attempts.push({ attemptId, purpose, durationMs, outcome, usage });
        await atomicJson(this.path, state);
      }
    } finally { await guard.close(); await unlink(`${this.path}.lock`); }
  }
}

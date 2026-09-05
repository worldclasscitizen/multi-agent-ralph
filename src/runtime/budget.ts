import type { RunBudget } from "../graph/schema.js";
import { RalphError } from "../util.js";
export class BudgetCounter {
  constructor(
    readonly limits: RunBudget,
    public attempts = 0,
    public activeMs = 0,
  ) {}
  reserveAttempt() {
    if (this.attempts >= this.limits.maxAttempts)
      throw new RalphError(
        "Run invocation budget exhausted",
        "budget_exhausted",
        10,
      );
    this.attempts++;
  }
  remainingMs() {
    const remaining = this.limits.activeMs - this.activeMs;
    if (remaining <= 0)
      throw new RalphError(
        "Active execution time budget exhausted",
        "budget_exhausted",
        10,
      );
    return remaining;
  }
}

# Benchmarking

The packaged `ralph-quality-24-v1` suite contains six task types with four difficulty and risk levels each. These are live repository tasks with hidden deterministic checks, not the 24 synthetic Critic unit fixtures.

```bash
ralph benchmark run --repetitions 5
ralph benchmark run --case backend-medium-idempotency --repetitions 5
ralph benchmark report <run-id>
ralph benchmark compare <baseline-id> <candidate-id>
ralph benchmark baseline set <run-id>
ralph benchmark calibrate <run-id> --case <case-id> --repetition 1 --outcome pass --note "human evidence review"
```

Release candidates should use ten repetitions. Beta development uses five by default.

v0.3 runs these cases through the graph planner and the same approval/execution engine as the CLI. Independent tasks can become parallel workers; a validated single-worker fallback remains possible. Use the identical suite, models, budgets and repetitions on the fixed v0.2 checkout for comparison. No such live comparison has been completed for this beta.

The primary metric is **Qualified Success Rate**: Ralph must finish successfully and the hidden verifier must pass. Independent Critic scores remain separate supporting evidence. Sampled human calibration can be attached without replacing deterministic results. Reports also retain Wilson 95% intervals, bootstrap 95% mean intervals, p50/p95 duration, token use, iteration count, and official estimated cost when the provider supplies it.

A cheaper or faster route is accepted automatically only when qualified quality does not regress. Token use is never presented as an account balance, and subscription usage is never converted to fictional dollar cost.

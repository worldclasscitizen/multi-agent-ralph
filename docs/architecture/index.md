# Graph execution architecture

Ralph 0.3 keeps the iterative Loop inside each worker and makes the run supervisor the sole writer of execution state. A local TypeScript engine owns the DAG; there is no external workflow service.

## Contracts and identities

`src/graph/schema.ts` is the TypeBox/Ajv definition for graph revisions, node specifications, budgets and event payloads. `ExecutionPlan` contains the frozen configuration, contract, context, graph and envelope. Its canonical hash covers all of those values. `approvePlan` and `assertPlanApproved` enforce exact-plan approval; v0.2 hashes are not accepted.

| Identity | Lifetime |
|---|---|
| runId | Request through delivery |
| revision | One immutable DAG topology |
| nodeId / generation | Logical task and immutable input generation |
| iteration | Logical worker improvement count; retained across generations |
| invocationId | One logical model request |
| attemptId | One provider attempt |
| artifact ID | SHA-256 of canonical sanitized evidence |

Control stages (planning, clarification and approval) appear in the same event ledger but are separate from the executable work graph. Read-only answer mode contains no worker or integration node. A single-worker change still has integration and validation nodes.

## Compilation and scheduling

`compileGraph` rejects duplicate IDs, unknown references, cycles, unapproved paths, traversal, unavailable declared capabilities, unknown verification commands, and workers disconnected from final integration/validation. Overlapping writing nodes receive an ordering/artifact dependency. Independent inputs are assembled before the node runs.

Only all-of dependencies are supported. Ready nodes are ordered by the number of downstream tasks, then their original order. Completed predecessors never wait for unrelated worker iterations. The supervisor shares a connection semaphore and a conservative verifier semaphore. Verifier commands execute serially across workers because arbitrary project tests may share ports or external resources.

Defaults: four workers; one invocation per connection; 32 nodes per revision; 64 generated node generations; eight revisions; two integration repairs; 256 total attempts; two hours of active runtime; six iterations per logical worker. Input waiting is outside the active clock. The full budget is visible in the plan. Modifying it invalidates approval.

## State and persistence

Run states: planning, awaiting_input, ready, running, stopping, paused, completed, failed, cancelled.

Node states: pending, queued, running, verifying, retry_wait, blocked, completed, failed, cancelled, interrupted. `runtime/transitions.ts` validates legal transitions before append. Completion requires a matching node result. Terminal runs cannot be silently reopened.

At project initialization, `statePaths` resolves the Git-internal root. Workers receive that resolved location; they never recompute it from their own worktree.

```text
<git-path-ralph>/
  config.json
  locks/graph-owner.json
  runs/<run-id>/
    plan.json
    context.json
    question.json                 # only while needed
    events.jsonl
    snapshot.json
    nodes/<node-id>/<generation>/
      workspace.json
      loop.json
    artifacts/<sha256>.json
    commands/<command-id>.json
    workspaces/<node-id>-<generation>/
    integration/delivery.json
```

Graph revisions are authoritative `graph.revised` ledger events. Snapshots are derived caches. The beta intentionally keeps graph/spec storage in the ledger and `plan.json`, rather than maintaining another authoritative copy per revision.

Appends are serialized, schema validated, sequence numbered and hash chained. The event is fsynced before its caller receives success. Snapshots use write/fsync/rename. Replay never invokes providers or Git. A truncated tail is copied aside and repaired by the owning recovery operation. A corrupt middle record blocks recovery. Local filesystem and Git semantics are required; network-mounted run state is unsupported.

`RunStore` provides append/readAfter/loadSnapshot/saveSnapshot/putArtifact, plus validated projections and ownership. Artifacts are immutable and checked on retrieval. Project locks contain run ID, PID, process start time and an ownership token. A live PID is conservatively treated as live, even when process identity cannot be proven.

## Worker acceptance

A worker restores immutable input, invokes the selected provider, checks its path scope, runs deterministic verifiers, and obtains an independent assessment. It checkpoints evidence before committing. A durable loop receipt reconciles interruption immediately before or after the Git commit; evidence and input digests must still match before reuse.

New files are staged before evidence diffs, so created files and binary changes are represented. Final validation compares the entire result against the original base HEAD, including already committed worker changes. A provider exit code or self-reported success is insufficient.

Feedback contains observations, findings, unresolved criteria and failure fingerprints. It does not record hidden reasoning. A different provider is preferred for evaluation when approved and available; same-provider evaluation is labeled. The beta uses fresh sessions and evidence transfer, so incomplete usage telemetry never causes unsafe session reuse.

## Revisions and integration

Replanning is explicit. `reviseGraph` increments affected generations and downstream generations, keeps unchanged completed nodes, and refuses to mutate active input. Old generations remain in the ledger. Failed final integration or verification creates a repair worker depending on the completed original workers, followed by fresh integration and verification generations. Repair retains the logical iteration budget.

Each result exports only the difference between its input commit and output commit. Dependency results are deduplicated and applied in topological order. Binary, deletion and rename changes use Git patches. Final integration conflicts are committed as an isolated failed-input snapshot with the rejected patches and error evidence. A new repair worker starts from that snapshot, resolves the conflict, and passes independent verification before integration resumes. Conflicts while assembling an intermediate worker input remain blocked for inspection. A validator never edits code to make its own check pass.

Delivery constructs one result commit parented by the starting HEAD and records a durable receipt. Git's prepared reference transaction locks HEAD and its branch while the runtime rechecks the original branch, HEAD and working tree. A guarded two-tree checkout and compare-and-swap reference update deliver the commit. Existing result receipts make replay after successful delivery idempotent. User changes preserve the result branch and require inspection. No forced reset or automatic push occurs.

If the process dies during the checkout portion of delivery, inspect the preserved index/worktree and result branch before retrying; the beta intentionally does not overwrite an ambiguous user workspace.

## Failure semantics

| Stage | Bounded behavior |
|---|---|
| Context | Optional files may be missing; invalid required input is surfaced |
| Contract planner | Up to three proposals with independent review |
| Graph planner | Up to three compiled proposals, then a reviewable single-worker graph |
| Router | Deterministic approved candidates, pins and comparable history |
| Worker | Six logical iterations, repeated-failure and stagnation stops |
| Integrator | Deterministic Git application; final conflicts produce bounded repair revisions |
| Validator | Commands and independent rubric; repair revisions bounded |
| Supervisor | Ledger replay; uncertain invocations prevent duplicate work |

For an invocation without a confirmed outcome, automatic process replacement is prohibited. Recover the actual process/workspace first and, when uncertain, form a new reviewed plan. This conservative path is part of the beta's explicit limits, not a promise of transparent recovery for arbitrary external side effects.

## Library

```ts
import { planRun, approvePlan, startRun, resumeRun, submitResponse, watchRun } from '@worldclasscitizen/ralph';
const plan = await planRun(projectRoot, request);
// Present the complete plan and obtain explicit approval in the host.
const state = await startRun(approvePlan(plan));
```

`startRun` accepts an AbortSignal. `resumeRun(projectRoot, runId)` uses the saved approval. `watchRun` yields sequence-based events and stops at terminal or input-waiting states. The deprecated `executeContract` rejects old approvals.

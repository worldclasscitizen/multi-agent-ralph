# CLI reference

All graph commands resolve the project through `--project <absolute-git-root>` or the current Git repository. JSON/NDJSON go to stdout; interactive guidance goes to stderr.

| Command | Meaning |
|---|---|
| plan "request" --json | Collect context, compile and save a reviewable plan |
| plan "request" --mode single | Request one worker plus integration and validation |
| plan "request" --mode answer | Explicit read-only response path |
| plan "request" --host-context /absolute/context.json | Add explicitly supplied host summary |
| plan --from-run legacy-id --json | New unapproved plan linked to preserved history |
| run "request" | Plan, then interactive exact-plan approval |
| run --plan run-id --yes | Approve and run an already reviewed saved plan |
| run --plan-stdin --yes | Approve and run reviewed plan JSON on stdin |
| run --plan run-id --yes --events ndjson | Stream durable execution events |
| graph show run-id --format json | Compiled graph |
| graph show run-id --format mermaid | Static diagram text |
| explain run-id --node node-id | Node result and associated events |
| respond run-id --request question-id --stdin | JSON string-map answers, same run ID |
| status [run-id] --watch | Current run projection |
| stop run-id | Request controlled interruption |
| stop run-id --force | Request cancellation; does not discard work |
| resume run-id | Continue confirmed execution state |
| usage | Deduplicated graph attempt usage |
| logs run-id --follow | Sequence-based event log |
| dashboard --open | Packaged local UI |
| migrate --to 0.3 --dry-run | Classify legacy state without writing |
| migrate --to 0.3 | Preserve legacy state and write migration manifest |

Host context JSON is `{ "summary": "Explicit context supplied by the host" }`. It cannot extend approval scope. A clarification response is `{ "clarify": "Target paths, desired behavior and completion checks" }`; use the actual question IDs returned by the run.

Exit code 10 means approval, required input, recovery or other operator action is needed. In noninteractive execution, the response includes the run ID and structured question or pending state. Required consent is never inferred from elapsed time. A fresh `run "request" --yes` is rejected; inspect `plan` first.

Existing `init`, `doctor`, `auth`, `config`, `providers`, `catalog`, `integrations`, `capacity`, `history`, `recover`, `benchmark` and legacy `migrate` utilities remain available. `show` and `draft` are compatibility utilities; new hosts should use graph commands.

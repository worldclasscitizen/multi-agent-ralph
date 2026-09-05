# Ralph v0.3: start here

Read [README](README.md) or [한국어](README.ko.md) first. This checkout implements local graph runs; stable release depends on [readiness evidence](docs/project/v0.3-readiness.md).

1. Build this checkout: `npm ci`, `npm run build`, `npm link`.
2. In a clean Git project, run `ralph init` and `ralph doctor`.
3. Run `ralph plan "your request" --json`, review the complete plan, then `ralph run --plan <run-id> --yes`.
4. Inspect `ralph dashboard --open`, `ralph graph show <run-id>`, and `ralph explain <run-id> --node work`.
5. For old records, first use `ralph migrate --to 0.3 --dry-run`. See [migration](docs/migration/v0.3.md).

Consumer state stays under `git rev-parse --git-path ralph`. Never copy runtime files into a consumer repository. Host integrations use the same CLI and exact-plan approval.

Source ownership: `src/graph` compiles DAGs; `src/runtime` owns execution; `src/storage` persists evidence; `src/gateway` routes calls; `src/loop` improves nodes; `src/workspace` manages Git; `ui` builds the packaged dashboard. `legacy` remains historical Bash code.

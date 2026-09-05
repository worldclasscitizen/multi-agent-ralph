# Dashboard and event API

Run `ralph dashboard --open` inside a configured project. The HTTP server binds to 127.0.0.1; the npm package includes built React/TypeScript/React Flow assets and ELK. No frontend development server is required by users. Developers edit `ui/src` and run `npm run build:ui`.

## Interaction

The sidebar aggregates one row per run. Legacy records have an explicit label. The graph shows dependency edges, node status, model identity, iterations and duration. ELK layout runs only when the selected run or graph revision changes, preserving placement on live status updates. Select a historical revision for read-only inspection.

The inspector shows model selection rationale, generation, iteration, evidence, a file diff and recent event details. Work summaries and validation records are shown; hidden reasoning is not collected. Provider metrics show measured/unknown usage, call distribution and task-category counts. Logs use progressive disclosure and a bounded recent-event view. Full virtualization and large-scale accessibility audits remain release-gate items.

Text uses 14px by default and at least 13px for table/log content. State is represented by text and styling rather than color alone. Smaller viewports retain a dismissible inspector.

## HTTP v2

| Method and path | Response |
|---|---|
| GET /api/v2/runs?offset=0&limit=30 | Paginated runs and total |
| GET /api/v2/runs/:id | Projection with last applied seq |
| GET /api/v2/runs/:id?revision=1 | Historical projection |
| GET /api/v2/runs/:id/graph?revision=1 | Graph revision |
| GET /api/v2/runs/:id/nodes/:nodeId?revision=1 | Node generation and events |
| GET /api/v2/runs/:id/events?after=42 | SSE events after seq 42 |
| GET /api/v2/runs/:id/artifacts/:sha256 | Integrity-checked sanitized artifact |
| POST /api/v2/runs/:id/commands | Idempotent command submission |
| GET /api/v2/providers | Configured connection support status |
| GET /api/v2/metrics | Per-connection/model usage projection |
| GET /api/v2/session | Local control token |

SSE uses `event: ralph` and sequence numbers as IDs. `Last-Event-ID` overrides the query cursor. The client first loads a snapshot, then opens the stream from its seq, so reconnects can recover intervening events. Slow streams close when the transport buffer fills; clients reconnect by cursor. Usage projections deduplicate attempt IDs.

Commands include `commandId`, `expectedRevision`, and a type (`stop`, `cancel`, `resume`, `approve_final`, `note`). Reusing an ID with a different payload returns conflict; the same payload is idempotent. A stale new command returns 409. Commands are submitted as durable files; only the owning supervisor applies execution-state changes. Initial plan approval and clarification currently use the CLI/library, not this HTTP command set.

POST requires `X-Ralph-Token` from the same-origin session endpoint. Both legacy and v2 handlers check Origin; the server rejects non-loopback Host values. Artifacts are addressed by validated IDs, never arbitrary filesystem paths. Logs are local and may contain project-specific evidence; a control token is not multi-user authentication.

## Verification

`npm run test:e2e` starts a mock-provider run in a temporary Git project, then exercises the real packaged dashboard with Chromium. `tests/graph-api.test.ts` verifies SSE cursors, protected writes, duplicate commands, artifact path rejection and metrics. Screenshots under `test-results` are generated evidence, not hand-drawn mockups.

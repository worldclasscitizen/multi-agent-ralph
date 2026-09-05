# Capability maturity

Current work is the v0.3 beta graph runtime. [Release readiness](v0.3-readiness.md) separates local tests, live-provider evidence and outstanding stable gates.

| Capability | Status | Evidence or limitation |
|---|---|---|
| Contract and graph approval | Implemented | Exact saved-plan hash; approval changes invalidate execution |
| Parallel graph execution | Implemented | Real worktree fan-out, fan-in, shared-input deduplication |
| Durable replay and recovery | Beta | Torn tails, loop commit receipts, conservative uncertain-call handling |
| Final integration repair | Implemented | Bounded repair revision; original worker generations preserved |
| Provider gateway | Beta | Protocol tests and bounded Codex smoke; other live evidence incomplete |
| Local quality measurements | Beta | Comparable task/verifier samples and Wilson lower bounds |
| Dashboard | Beta | Packaged graph canvas, evidence, SSE, keyboard and virtualized diff checks |
| Migration | Beta | Original records/configuration preserved; new approvals required |
| Stable release | Gated | Critical coverage, cross-platform CI, live providers and baseline comparison |

Ralph does not claim superiority from architecture alone. Faster completion is useful only with independently verified quality and reproducible measurements.

# Providers and Dynamic Mesh Routing

Provider, connection and execution transport are separate. Codex login and OpenAI API are distinct connections with independent limits. Only enabled, configured connections are candidates. Installation/authentication checks do not prove that a particular model works.

## Configuration

Run `ralph init`, `ralph providers list`, and `ralph auth status` in the target Git project. API credentials come from the environment or the existing OS credential store. Windows currently uses environment variables; Windows Credential Manager is not implemented.

| Connection ID | Environment variable | API transport |
|---|---|---|
| openai:api | OPENAI_API_KEY | Responses |
| anthropic:api | ANTHROPIC_API_KEY | Messages |
| google:api | GEMINI_API_KEY | generateContent |
| deepseek:api | DEEPSEEK_API_KEY | Chat completions |
| zai:general | GLM_GENERAL_API_KEY | Chat completions |
| zai:coding-plan | GLM_API_KEY | Chat completions |

For a DeepSeek + GLM-only environment, set just the corresponding environment variables before initialization. Remove or disable other entries from the reviewed project configuration if unrelated local CLI logins were automatically detected. `ralph config refresh` recalculates routes from configured connections. All planner/worker/critic roles can use the remaining portfolio.

For another compatible endpoint, add an explicit connection with adapter `openai-compatible`, mode `api`, a `baseUrl`, an `apiKeyEnv` reference and known `models`. Add candidate routes through `ralph config route set`. Compatibility requires the model's actual tool calling and text output behavior; an OpenAI-shaped URL alone is insufficient. Ollama without authentication needs an explicitly configured local placeholder credential because the compatible adapter requires a credential reference.

## Assignment

Hard Pins and fixed routes take priority. Adaptive worker assignment orders approved candidates by catalog quality, then comparable local observations. Only samples in the same task category and verifier protocol with at least 20 terminal logical tasks are compared. Wilson's lower confidence bound is used within equal catalog quality. Inadequate samples preserve catalog order. Latency and available cost break later ties according to profile; no random exploration is performed.

`gateway/measurements.ts` defines benchmark provenance: family, source URL, model revision, harness version, measurement date, sample count, metric, value, unit and task category. The separately signed v2 catalog uses official model sources and marks unsupported quality measurements `unrated`. The original v0.2 catalog and signature are retained only for the legacy channel. Scores from different benchmarks are not combined. The plan snapshots empirical history so ranking does not change underneath an approved run.

## Transport contract

`ProviderAdapterV2` exposes describe, probe, listModels and an AsyncIterable invocation. `InvocationRequest` carries logical/attempt IDs, run/node/generation, workspace root, model, bounded permissions, context and deadline. Current adapters emit normalized final-result/error events; token-level streaming is not fabricated for transports that only return a complete response.

The gateway owns retries, connection concurrency and circuit state. It permits at most two attempts per candidate and six per logical request, bounded again by the run total. `Retry-After` is honored; transient errors use delay plus jitter. Pinned models never rotate. Authentication, permissions and nonretryable provider refusals stop with an actionable state. A failed worker that already changed files is preserved for inspection before another attempt.

Worker context overflow uses a bounded evidence-backed prompt retaining the full contract and immutable input references. Planner/critic overflow without a safe compact prompt pauses; the gateway never silently truncates acceptance criteria. Uncertain cancellation cannot be interpreted as permission to start another worker. CLI subprocess cancellation waits for closure and terminates its process tree. Unreported tokens are absent, not zero; pricing-derived cost remains an estimate.

## Support evidence

Support statuses are `verified`, `experimental`, `compatible`, `unavailable`. Installation and authentication alone never grant `verified`. The probe can report verification only when a packaged evidence record matches the installed CLI version, platform, Node.js major version and freshness window. Records come from release reports; README, CLI and dashboard share this data. Mock tests exercise error handling and usage normalization separately.

The stable campaign used Codex CLI 0.153.1, gpt-5.6-luna, Windows and Node.js 24.11.1. Its four [transport checks](../project/evidence/live-provider.json) passed. The subsequent [graph comparison](../project/evidence/live-comparison.json) stopped before integration and remains historical reference. Transport reuse requires proof that its source files, requests, dependency lock and environment are unchanged; the original report and date are preserved. Stable end-to-end support still requires natural-language planning through verified delivery. See the [campaign review](../project/release-campaign-2026-09-05.md).

Earlier beta records for Codex CLI 0.153.1 and gpt-5.4-mini are preserved as [historical smoke evidence](evidence/codex-windows.json), including the [initial failed check](evidence/codex-windows-initial.json). They are not used to establish current model availability or stable support.

Claude Code 2.1.158 reported a saved login but the actual request returned an expired OAuth error. Its [report](evidence/claude-windows.json) marks the remaining model checks blocked. Gemini authentication was unknown. No API credential was available in the current environment; native API and DeepSeek/GLM evidence is protocol-level mock testing. Credentials and account identifiers are excluded from reports.

Run `node scripts/provider-conformance.mjs --help` for opt-in live checks. The published record lives in [release readiness](../project/v0.3-readiness.md). Mock fixtures prove protocol handling, not service availability or model quality.

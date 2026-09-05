# Stable release campaign: 2026-09-05

**Release status: blocked.** PR [#3](https://github.com/worldclasscitizen/Ralph/pull/3) remains a draft. No main merge, npm 0.3.0 publication or public GitHub release has occurred.

## Measured results

CI [33930145345](https://github.com/worldclasscitizen/Ralph/actions/runs/33930145345) passed on Windows, macOS and Linux with Node.js 22 and 24 at commit `0b1457f37193b988e3aae79ca793357d31969ae5`. All six environments installed the same archive. Each operating system completed five repetitions of five real process interruption boundaries. That CI result predates the subsequent benchmark harness fix; the PR must pass CI again at its final commit.

| Live check | Result | Calls | Wall time |
|---|---|---:|---:|
| Codex transport conformance | Four checks passed | 4 | Approximately 32 seconds |
| Fixed v0.2 baseline, first trial | Completed; external oracle passed | 5 | 217.944 seconds |
| v0.3 candidate, first trial | Paused before integration | 6 | 241.533 seconds |
| Remaining paired trials | Not run | 0 | — |

Total allowance consumption was **15 / 24 calls and 480,712 / 1,800,000 aggregate active milliseconds** (8 minutes 0.712 seconds). Cancellation and unsuccessful work count. API spending was zero. Token measurements are retained in the [failed comparison report](evidence/live-comparison.json); no monetary estimate is invented for the subscription connection. The [conformance report](evidence/live-provider.json) records the actual model `gpt-5.6-luna`, CLI `0.153.1`, Windows and Node.js `24.11.1`.

## Failure and correction

The public task supplied only syntax checks and `git diff --check`. Its hidden external oracle ran only after final delivery. A candidate reviewer correctly reported missing behavioral evidence and scored the left branch 55.5, causing another worker iteration. The right branch completed after boundary adjudication, but the per-comparison six-call ceiling stopped the left branch before integration. No candidate completion or recovery success is inferred from its generated files.

Before the first candidate began, commit `8d6fb34aca21035a7609c0eaaabb7e66016e410f` narrowed each worker's goal to its own module. The baseline had already started with the previous harness. Both versions still used the same function contract, model and external oracle, but this mixed harness history is explicitly retained and cannot qualify as the final comparison.

The corrected fixture now contains frozen public behavioral examples for both modules. Both versions run those same tests. Each worker validates only its own module; the final node validates both. Workers cannot modify the test files. The external oracle remains separate and checks additional cases. Regression tests require that placeholders and incorrect implementations fail, and that an unfinished sibling does not fail a completed branch's local tests.

The campaign now records each trial's source identity, rejects source changes during execution, preserves failed trials, and checks the mock-estimated minimum call count against the remaining allowance before starting paid work. Nine remaining calls cannot finish a new comparison estimated at eighteen calls, even before conformance checks or retries. No additional live calls were started and no allowance was reset or increased.

## Deployment preparation

GitHub main requires the PR and six matrix checks plus the package check, without a separate human approval requirement. The `npm-release` environment permits main only. The new catalog signing key is outside the repository and stored as an encrypted environment secret; only its public key is published. Immutable GitHub releases are enabled.

The npm Trusted Publisher is configured for `worldclasscitizen/Ralph`, `release.yml`, environment `npm-release`, with direct `npm publish` permission. User security-key authentication completed successfully. Authentication setup is complete; publishing remains blocked by the verification results above.

## Original resumption conditions (superseded)

현재 정식 출시는 보류 상태입니다. 공급자 통신 검증은 통과했지만 그래프 실행의 필수 비교를 끝내지 못했습니다. 동작 검증을 보완한 뒤 모의 시험으로 재확인하며, 실패 이력과 남은 호출 예산은 보존합니다.

실검증을 재개하려면 수정한 동일 코드·검증 계약에 대한 비교와 공급자 보고서가 필요합니다. 남은 9회로 필수 비교를 완료할 수 없으므로 예산 변경은 사용자의 별도 결정 사항입니다. 검사 횟수나 통과 기준을 낮춰 출시하지 않습니다. 모든 출시 조건을 통과한 이후에만 PR 병합, 정확한 main 커밋의 재검증, npm 게시, GitHub Release 공개를 진행합니다.

## Approved functional release gate

The owner subsequently selected natural-language graph execution through verified delivery as the mandatory live gate. Repeated baseline comparisons are now historical reference. This is an explicit gate change, not a successful rerun of the failed comparison. The original reports, attempts and consumption above remain unchanged.

The remaining allowance is nine calls and 1,319,288 aggregate active milliseconds. A new generated-graph mock completed in eight calls. Before real work, source-byte proof must confirm reuse of the original four transport checks. No contract or graph is injected into the new real test; scope and frozen verifiers are checked before exact-plan approval. An incomplete real run still blocks release, and the allowance is never increased automatically.

사용자 선택에 따라 자연어 요청부터 그래프 생성·작업·검증·결과 반영까지의 실제 완주를 필수로 변경했습니다. 구버전 반복 비교는 참고 이력으로 보존합니다. 호출 한도는 그대로이며, 남은 예산 안에서 필수 검증을 마치지 못하면 출시를 보류합니다.

## Natural-language trial and contract schema correction

At source b1acb2dea2e79048f40d6241ce2f467a4cc0dc82, the new live trial stopped during contract planning after two calls (38.158 seconds wall time). The runtime persisted awaiting_input; neither the graph planner nor any worker started. Both returned JSON objects used objective instead of the required goal field and also contained worker/integration structures. The prompt named TaskContract without supplying its schema. The validator correctly refused both responses. See the original [failed functional report](evidence/live-functional.json) and the [response-shape review](evidence/live-functional-review.json), which records response hashes without private workspace paths.

The correction supplies one explicit TypeBox draft schema to both the contract prompt and the local draft validator. Errors name the missing field. Programmatic contract normalization remains compatible. Regression tests reject the observed wrong shape, malformed verifier arrays and invented approval fields. The corrected mock completes generated planning, two workers, integration, final validation, branch delivery and external acceptance in eight calls. This is mock evidence, not a corrected live success.

Transport evidence remains reusable: the adapter and fixture helper's recursively imported source files, original conformance requests, allowance implementation and lockfile are unchanged. The initial conservative 68-file comparison was narrowed to the actual 15-file dependency set; contract prompting is separately covered by the end-to-end gate. The original provider report and check date remain intact.

Total consumption is now **17 / 24 calls and 515,096 / 1,800,000 active milliseconds**. Seven calls remain, below the eight-call normal path. No further real call, allowance increase, main merge or publication has occurred. Retained run: run-8d700c7e-e441-49b8-ab87-7cd44141b11b.

실제 시험에서 계약 JSON 형식 안내 누락을 발견해 수정했습니다. 두 응답 모두 목표를 objective에 담았지만 런타임은 goal을 요구했습니다. 그래프와 Worker는 시작하지 않았습니다. 수정 후 모의 완주는 통과했으나 실제 재시험은 하지 않았습니다. 총 17회 사용·7회 잔여이며, 정상 경로의 예상 8회보다 부족해 정식 출시는 계속 보류합니다.

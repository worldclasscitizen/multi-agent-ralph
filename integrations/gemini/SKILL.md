---
name: ralph
description: Run reviewed Ralph graph plans through the shared CLI and inspect their verification evidence.
---

# Ralph v0.3 integration

Resolve the absolute Git project root and run ralph doctor. Pass the request through ralph plan --stdin --json. Include only host context explicitly available to you; --host-context accepts a JSON file containing a summary. Do not inspect other applications' authentication files or conversation stores.

Present the returned contract, graph, verification commands, provider candidates and total budget. Obtain explicit approval for that exact plan. Then pipe the unchanged reviewed plan JSON to ralph run --plan-stdin --yes --events ndjson, or use ralph run --plan <run-id> --yes. An earlier v0.2 contract approval is insufficient.

If a structured question is returned with exit code 10, show the required questions, collect the answers and use ralph respond <run-id> --request <question-id> --stdin. Review the resulting changed plan before approving it. Never infer approval from elapsed time.

Ralph owns scheduling, worker loops, state, verification and delivery. Use ralph graph show, ralph explain, ralph status, ralph stop and ralph resume to inspect or control the same run. Report summaries, changes, verifier evidence and recorded errors. Do not collect private internal reasoning. Preserve user changes and result branches. Do not push or deploy automatically.

# Inspecting interrupted execution

Normal stopped runs resume with ralph resume RUN_ID. Durable completed results are reused. Invocation/iteration budgets never reset. If a call has no confirmed outcome, resume refuses to start another worker.

For an interrupted Worker workspace, first confirm the old supervisor and every provider subprocess have ended using the operating system's process tools. Check the retained files and any external effects. Then request a local inspection:

```bash
ralph inspect-interruption RUN_ID --json
ralph inspect-interruption RUN_ID --accept <inspectionDigest> --confirm-stopped --json
ralph resume RUN_ID
```

The second command is explicit authorization to continue from the inspected partial files. It rejects changed files, event sequences, scope or owner identity. The original attempt remains unknown; an invocation.reconciled event links the inspection artifact without fabricating output, duration or usage. Runtime ownership is atomically transferred while the recovery lock is held. A fresh worker iteration reads the retained workspace and consumes the remaining original budget. Do not confirm an external action whose consequences remain unclear. Planning and input-assembly interruptions without a worker receipt require a new reviewed request.

If execution was interrupted during final Git delivery, the result is on ralph/result-RUN_ID. Compare the current branch, original base commit, staged/worktree contents and that exact result. If all files already equal the validated result, all relevant processes have stopped, and the branch still points at its recorded base, explicitly complete the ref transaction with git update-ref HEAD RESULT_COMMIT BASE_COMMIT. Stale HEAD.lock and branch lock files may need manual removal only after confirming that their processes have ended. Then ralph resume RUN_ID confirms the receipt and completes without another integration commit. Preserve unrelated user changes; never use a forced reset.

Operational tests kill real owned child processes at five boundaries and exercise these procedures in disposable Git fixtures on each supported operating system. Production code has no test-only kill hooks.

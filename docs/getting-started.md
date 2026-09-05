# Install and first run

Build the reviewed v0.3 checkout before using its graph commands:

```bash
npm ci
npm run build
npm link
cd /absolute/path/to/a/clean/git-project
ralph init
ralph doctor
ralph plan "Implement a bounded change and verify it" --json
```

Review the contract, graph, paths, verification commands, provider candidates and budget. Use the returned run ID:

```bash
ralph run --plan <run-id> --yes
ralph dashboard --open
```

Do not save exported plans inside the consumer working tree. For host-controlled approval, deliver reviewed JSON over stdin to `ralph run --plan-stdin --yes`. The local runner continues independently of the observing CLI. `ralph stop` requests interruption and `ralph resume` checks the saved execution before continuing.

See [provider configuration](providers/index.md), [CLI options](reference/cli.md), and [migration](migration/v0.3.md). This checkout is beta; npm stable release and live conformance are governed by [release readiness](project/v0.3-readiness.md).

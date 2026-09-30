# MINI shared-server experiment — thin attached clients

## Status and recommendation

**Recommend integration after combined checks.** Three alternating paired native
measurements show lower attached-client memory, startup CPU and readiness time.
The focused suite and compiled permission/tool/resume/fork flows pass. The
production `oc` installation and original checkout were not changed.

## Hypothesis and intended comparison

Attached mini clients should avoid AppRuntime, the backend AppNodeBuilder import
graph, Database initialization and backend-native helper imports. This should
reduce idle client/fleet PSS and startup CPU without altering session semantics.
Countermetrics: first-input readiness, provider/tool-round completion,
queue/steer/cancel/restart/replay behavior and standalone/headless regressions.

- Frozen baseline commit: `8998bdb660d66c31a6e390c1195867b6c303c781`.
- Binary: `/tmp/opencode/shared-server-base-bin/opencode`.
- Baseline SHA256: `9a789076b6e7dda31664a058604a2aa2b8c26f629ce533e8f2d2ddae79e3a2ee`.
- Version: `0.0.0-shared-server-202609301000`.
- Assigned worktree/branch: `/home/shawn/code/opencode-server-mini`, `server-mini`.
- Frozen candidate: `/tmp/opencode/server-mini-parent-bin/opencode`.
- Candidate SHA256: `f426d677b039faf4ce7d0ae4169bc6e1b5cbbe178d53a9ed0037c9bcce37b7fd`.
- Candidate version: `0.0.0-server-mini-202609301012`.

## Implementation

- `effect-cmd.ts`: optional client-only handler dispatched before importing
  AppRuntime. Existing backend handlers retain their runtime and instance scope.
- `run.ts`: common async run body, attached client handler, local Effect handler
  supplying local agent validation and runtime flags. Attached mini reads
  background-subagent capabilities through the backend SDK.
- `run/runtime.boot.ts`, `stream.transport.ts`, `variant.shared.ts`: use Core's
  context-free runtime rather than opencode's instance/workspace runtime;
  variant persistence compiles FSUtil with LayerNode instead of AppNodeBuilder.
- `runtime.ts`, `runtime.queue.ts`: use Schema's legacy wire IDs rather than
  importing the backend Session schema facade.
- `runtime.lifecycle.ts`: avoid importing backend Session for generated-title
  recognition. `tool.ts`: avoid importing the backend web-search tool for a
  display label.

Auto-share reads Effect Config directly on attached invocations; local invocations
retain their RuntimeFlags service. Remote agent validation remains SDK-backed.
`run.ts` has a large whitespace diff because extraction
out of the Effect handler reduced indentation; review with `git diff -w`.
Likely integration touchpoints are the run bootstrap and mini runtime files.

## Measurement harness and raw paths

`script/server-mini-bench.py` uses real Linux controlling PTYs at 120x40,
isolated HOME/XDG/config/project paths, an in-process local deterministic OpenAI
provider, daemon plus unique descendant-process PSS from `/proc`, startup CPU
ticks, and footer readiness. Default workload is N=1/N=4, five-second matched
settling, three paired repeats with alternate arm order, artifact hash checks
before/during/after. It measures warm backend attachments; daemon start/location
warmup is outside client startup timing. Active flows run separately so permission
and provider waits do not affect idle measurements. No forced GC or heap snapshots
were used during timing. Each sample uses a fresh isolated daemon and database;
the binaries have different development-channel database suffixes.

Medians of three paired repeats (MiB is KiB/1024). Startup CPU sums the clients;
readiness is the slowest client in each sample. Fleet PSS includes daemon and
unique descendant processes, avoiding RSS shared-page double counting.

| Clients | Metric                  | Baseline | Candidate |
| ------- | ----------------------- | -------: | --------: |
| 1       | Fleet PSS (MiB)         |   534.04 |    431.61 |
| 1       | Clients PSS (MiB)       |   223.15 |    108.69 |
| 1       | Startup client CPU (ms) |     1500 |       620 |
| 1       | Ready (ms)              |  1248.45 |    740.19 |
| 4       | Fleet PSS (MiB)         |  1077.09 |    648.12 |
| 4       | Clients PSS (MiB)       |   772.46 |    336.23 |
| 4       | Startup client CPU (ms) |     6770 |      2590 |
| 4       | Ready (ms)              |  1370.11 |    772.03 |

Fleet PSS ranges: N=1 baseline 533.68–558.82, candidate 431.04–481.14 MiB;
N=4 baseline 1064.74–1080.75, candidate 647.70–649.25 MiB. At N=4 this is
39.8% lower fleet PSS and 56.5% lower aggregate client PSS. These are warm idle
MINI attachments, not full-TUI, active-provider or production-fleet estimates.

Separate untimed `--trace` runs cover both binaries at N=1/N=4. Across all
traced client threads, each of the five baseline clients opens its SQLite
database, WAL and SHM; candidate clients have zero matching database opens.
This verifies the database initialization boundary. Native-helper initialization
was not independently classified, so no zero-native-helper claim is made.

Raw artifacts:

- `/tmp/opencode/server-mini-parent-before`: completed baseline-before sample.
- `/tmp/opencode/server-mini-parent-pairs/{samples.json,hashes-before.json,hashes-after.json}`:
  final paired samples and immutable executable checks. `summarize-server-mini.py`
  prints medians, ranges and individual values.
- `/tmp/opencode/server-mini-parent-traces`: separate diagnostic traces.
- `/tmp/opencode/server-mini-parent-flow-base-fixed/result.json` and
  `/tmp/opencode/server-mini-parent-flow-post/result.json`: matching native
  permission/tool/reopen/resume/fork flows, with PTY transcripts and durable history.
- `/tmp/opencode/server-mini-parent-flow-base-headless2/result.json` and
  `/tmp/opencode/server-mini-parent-flow-post-headless2/result.json`: final expanded
  flows also verify attached headless prompt admission and standalone headless
  JSON response. Each arm made five deterministic local provider calls.
- Earlier incomplete attempts below are not included in reported results:
- `/tmp/opencode/server-mini-before`: initial harness failed on Unix-socket
  daemon endpoint; harness now supports Unix HTTP for daemon control.
- `/tmp/opencode/server-mini-before2`: real PTY booted, but readiness predicate
  used mixed-case Build / a model label not actually painted. Raw
  `r0-n1-baseline/client-0.pty` contains the rendered mini footer.
- `/tmp/opencode/server-mini-before3`: rerun cancelled at context cutoff.
  Readiness now uses the actual `Ask anything` / `BUILD` footer.
- Logs are retained under `/home/shawn/.local/share/opencode/tool-output/`:
  `tool_0f1c58b32001wY41bovCnJcmQ2`,
  `tool_0f1c5f6af001hgIQAWGfeeNvxg`,
  `tool_0f1c6eaa2001XuHIyl0Gh3VNq2`.

## Checks and coverage

- Isolated offline frozen install passed (2334 packages); no dependency tree
  shared with another worktree.
- Bun.resolveSync confirmed Core, Schema, TUI and legacy SDK resolve into this
  worktree's packages.
- `bun run fix-node-pty` from this worktree's Core passed.
- Prettier passed for edited TypeScript files.
- The initial nonexistent `Flag.OPENCODE_AUTO_SHARE` draft reference was fixed.
  The final MINI typecheck reports only the pre-existing `/usage` `sdk.globalClient`
  error. Integration fixes that separately in `a60296f0fb24655cb3189ed7296e986f60d5eb99`;
  integration's package typecheck passes. This worktree is not claimed typecheck-clean.
- `bun test test/cli/run --timeout 30000`: **196 passed, zero failed**. This covers
  prompt order/removal, close-abort, stream interruption, missing-event polling,
  persisted replay and variant persistence through the actual implementation.
- Native single-platform CLI build and version smoke passed. Build/test log:
  `tool_0f1cccb9e001xpviQCKDUV2MGU`.
- Compiled baseline and candidate pass a real PTY permission footer reply,
  completed bash output, deterministic provider response, close/reopen/resume
  replay and fork history preservation. These are separate correctness checks,
  not provider/tool latency comparisons. No transparent daemon-replacement or
  independent V2 behavioral claim is inferred from the legacy flow.
- Every harness stops its isolated daemon and closes owned PTYs in `finally`.

## Reproduction

Use the shared benchmark lock. The recorded candidate is frozen; a newly built
binary is a new artifact and needs its own paired results.

```sh
# From packages/opencode: checks/build, never from repo root.
flock /tmp/opencode/shared-server-bench.lock bun typecheck
flock /tmp/opencode/shared-server-bench.lock bun test test/cli/run
flock /tmp/opencode/shared-server-bench.lock bun run script/build.ts \
  --single --skip-install --skip-embed-web-ui

# From this worktree root: paired native measurements with recorded artifacts.
flock /tmp/opencode/shared-server-bench.lock python3 script/server-mini-bench.py \
  --baseline /tmp/opencode/shared-server-base-bin/opencode \
  --candidate /tmp/opencode/server-mini-parent-bin/opencode \
  --out /tmp/opencode/server-mini-pairs --repeats 3 --settle 5
```

`script/server-mini-flow.py --binary <frozen-binary> --out <new-fixture>` runs the
compiled correctness flow under the same lock. `--trace` on the memory harness
adds separate diagnostic data and must not be included in performance medians.

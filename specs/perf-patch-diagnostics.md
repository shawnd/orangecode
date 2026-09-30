# Apply-patch diagnostic collection (table item 2)

Baseline tree: `e6f0f15a59125fb1775dd081da144ec16c4622aa`.
Assigned worktree: `/tmp/opencode/perf-batch/patch-diagnostics`.

## Mechanism and scope

`ApplyPatchTool` writes/formats all changed files and publishes filesystem events, then calls
`LSP.touchFile(target, "document")` sequentially. Each call opens/changes the document and
waits for diagnostics for that returned document version. A silent push-only server consumes
the existing five-second document budget for **each** file. The baseline probe measures this
through the actual tool, LSP service, client and a local stdio JSON-RPC peer.

The fix bounds concurrent document touches to eight. Repeated normalized targets form a
sequential group, preserving their notification count and document-version ordering. Different
documents can notify/wait concurrently. Filesystem mutations and event publication still finish
before diagnostic collection. The existing LSP startup deduplication, per-document version
checks, time budgets, diagnostic reporting and metadata shape remain in place.

This deliberately retains the paired notify-and-wait API. A global timeout around this batch
would skip queued notifications; separately touching every document and touching again to wait
would create extra document versions. A true notify-all/separate-wait API would require work in
the shared LSP/client modules. Neither shared module is edited here.

## Workload and measurement

- `test/tool/patch-diagnostics.bench.test.ts`, opt-in through `PATCH_DIAGNOSTICS_BENCH=1`.
- Real `ApplyPatchTool` initialization/execution, permissions accepted, isolated filesystem/config,
  real service layers and real child language-server process. Formatters disabled explicitly.
- 1, 4 and 12 newly added `.patchprobe` documents; 70, 193 and 525 patch bytes respectively.
- Responsive: versioned push after 10 ms. Slow: versioned push after 250 ms. Silent: no push.
  Responsive/slow modes send a deliberately stale-version empty push first.
- One discarded one-file responsive warmup, then two independent trials per workload/size.
  Each measured trial has a fresh instance and cold language-server startup.
- Wall time covers tool initialization/execution, writes, events, LSP startup, waits, reporting
  and output truncation. Fixture setup/teardown and the post-measurement server-statistics query
  are excluded. The service observer only delegates and counts calls/in-flight effects.
- Raw results include wall milliseconds, patch bytes, touches, document waits, peak concurrent
  touches, completions/interruption, server initializes/opens/changes/watched/published counts
  and the actual document versions/text seen by the external peer.
- Measurements are serialized with the shared `flock`. The raw `lockWaitMs` field is an **upper
  bound including Bun/test-preload startup**, recorded separately from tool wall time.
- Memory is not sampled: this is a latency/wait-concurrency change, not a retained-memory claim.

## Reproduction

Run from `/tmp/opencode/perf-batch/patch-diagnostics/packages/opencode`:

```sh
BENCH_REQUESTED_AT=$(date +%s%3N) flock /tmp/opencode/perf-batch/bench.lock \
  env PATCH_DIAGNOSTICS_BENCH=1 \
  PATCH_DIAGNOSTICS_OUTPUT=/tmp/opencode/perf-batch/patch-diagnostics-results/before.json \
  bun test test/tool/patch-diagnostics.bench.test.ts

# After applying the runtime change, same benchmark, output path changed only:
BENCH_REQUESTED_AT=$(date +%s%3N) flock /tmp/opencode/perf-batch/bench.lock \
  env PATCH_DIAGNOSTICS_BENCH=1 \
  PATCH_DIAGNOSTICS_OUTPUT=/tmp/opencode/perf-batch/patch-diagnostics-results/after.json \
  bun test test/tool/patch-diagnostics.bench.test.ts

bun test test/tool/patch-diagnostics.test.ts test/tool/apply_patch.test.ts test/lsp/lifecycle.test.ts
```

## Results

Mean wall time in milliseconds, two trials per cell (Bun 1.4.2, Linux x64):

| Server workload | Files | Before ms | After ms | Before / after | Peak touches before → after |
| --------------- | ----: | --------: | -------: | -------------: | --------------------------: |
| Responsive      |     1 |     455.4 |    461.9 |          0.99× |                       1 → 1 |
| Responsive      |     4 |     817.2 |    222.8 |          3.67× |                       1 → 4 |
| Responsive      |    12 |   2,090.0 |    499.3 |          4.19× |                       1 → 8 |
| Slow            |     1 |     448.0 |    566.4 |          0.79× |                       1 → 1 |
| Slow            |     4 |   1,667.0 |    458.9 |          3.63× |                       1 → 4 |
| Slow            |    12 |   4,889.1 |    858.2 |          5.70× |                       1 → 8 |
| Silent          |     1 |   5,055.5 |  5,049.2 |          1.00× |                       1 → 1 |
| Silent          |     4 |  20,055.5 |  5,061.3 |          3.96× |                       1 → 4 |
| Silent          |    12 |  60,061.0 | 10,057.4 |          5.97× |                       1 → 8 |

Every trial retains exactly **N touches, N document waits, N opens and N watched-file
notifications**, with one server initialize. Responsive/slow trials retain N diagnostic
documents and N current-version publishes; silent trials have none. Total measured work per
run: 102 touches/waits/opens/watched notifications, 68 diagnostic documents and 18 server
initializations (excluding warmup). No diagnostic work is removed to obtain the improvement.

Both benchmark runs passed all 19 cases (one warmup plus 18 samples), with 126 assertions each.
Before test-process time: 193.55 seconds; after: 48.88 seconds. Separately recorded lock-wait
upper bounds including harness startup: **2.329 seconds before, 75.635 seconds after**; these
are excluded from every table cell.

The single-file slow case measured 26% slower in this run. Single-document collection has no
concurrency benefit, and two cold-start samples cannot distinguish startup/scheduling variation
from a small-case regression. This benchmark supports the multi-document scheduling result,
not a claim of uniform speedup. Raw individual timings are retained rather than hiding that case.

## Correctness and residual risks

Verification: **47 tests passed, 0 failed, 151 assertions** across the new behavior tests,
existing apply-patch suite and LSP lifecycle suite (10.76 seconds). Prettier checks and
`git diff --check` passed. Broad package typechecking is deferred to the parent's combined check,
as requested by the assignment contract.

Targeted regression tests cover all returned errors, unchanged per-file metadata, stale pushes
followed by current-version diagnostics, a second patch advancing the open document version,
bounded concurrency with more files than slots, repeated path aliases, move destinations,
deleted-file exclusions, single server startup, silent-server waits and batch interruption.
Cancellation is checked via actual Effect fiber interruption: in-flight touch effects finalize,
queued touches never start, no diagnostic snapshot/success is returned, and already-applied
filesystem writes remain, as before.

The existing LSP service wraps native promises without forwarding cancellation to client wait
timers. Interruption stops tool work but already-started native waits can remain until their
existing timeout. This is pre-existing behavior; at most eight document touches per tool call
can now be in that state. No detached Effect fibers are introduced.

The bound is per invocation, not process-global. Multiple simultaneous tools retain their existing
cross-call coordination behavior. A silent server still costs roughly five seconds per wave of
eight distinct targets; this is not a constant global latency guarantee. Slow startup and client
request timeouts retain their existing behavior. Real LSPs may serialize internally, so the local
peer establishes the scheduling improvement rather than predicting every production server.

Integration overlap: the runtime change is confined to the diagnostic-touch block in
`packages/opencode/src/tool/apply_patch.ts`. The metadata agent may also edit this file; retain
both changes. No `lsp.ts`, `lsp/client.ts`, generated API, dependencies or configuration changes.

## Changed paths

- `packages/opencode/src/tool/apply_patch.ts`
- `packages/opencode/test/fixture/lsp/patch-diagnostics-server.js`
- `packages/opencode/test/fixture/patch-diagnostics.ts`
- `packages/opencode/test/tool/patch-diagnostics.bench.test.ts`
- `packages/opencode/test/tool/patch-diagnostics.test.ts`
- `specs/perf-patch-diagnostics.md`

Raw measurement artifacts: `/tmp/opencode/perf-batch/patch-diagnostics-results/{before,after}.json`.
No commits, dependency installation, build or deployment; combined integration/checks/deployment
belong to the parent task.

## Final integration with bounded LSP document retention

Integration combines the eight-way scheduling change with scoped diagnostic retrieval and
the LSP document lifecycle fix. The real 80-file regression initially returned only 64 diagnostic
entries: early documents were evicted before the original final cache lookup. The final tool
captures each target's scoped diagnostics immediately after its per-file wait and merges these
snapshots in deterministic target order. Normalized duplicate targets remain serialized and
retain their metadata entries; their unchanged contents now correctly produce no `didChange`.
Version assertions validate the server's actual increasing global document versions rather
than requiring every document to start at zero.

Three oversized files with both fast and slow servers reproduced another handoff race. The
client protects the open-to-wait handoff for one event turn and retains completed diagnostics
after eviction for at most ten seconds / 64 entries, without retaining document text. This
allows a fast server's completed diagnostics to survive while the same touch still waits for
a slower server. Details and limits are documented in `specs/perf-lsp-documents.md`.

Final integration verification: **82 tests passed, 0 failed, 407 assertions** across the patch
diagnostics, diagnostic metadata, patch retention, and LSP suites. Cancellation, concurrency
eight, deterministic target ordering, and per-file output remain covered. The additional test
fixture handles `didClose` and bounds diagnostic messages to their first source line so large
source files exercise text retention independently of diagnostic payload size.

Run from `packages/opencode`:

```sh
TMPDIR=/home/shawn/code/opencode/node_modules/.cache/perf-tests bun test ./test/tool/patch-diagnostics.test.ts ./test/tool/diagnostic-metadata.test.ts ./test/tool/patch-document-retention.test.ts ./test/lsp
```

The earlier timing table remains the historical isolated scheduling benchmark. The long
benchmark was not rerun for this correctness-only integration adjustment; its assertions were
updated to verify the combined global-version and no-op semantics. Parent owns the isolated
performance commit, combined verification, and deployment.

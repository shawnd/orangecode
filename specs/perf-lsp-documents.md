# LSP document lifecycle (table item 5)

Baseline tree: `e6f0f15a59125fb1775dd081da144ec16c4622aa` (the supplied worktree index, not HEAD).
Worktree: `/tmp/opencode/perf-batch/lsp-documents`.

## Finding and implementation

Confirmed in the actual `LSPClient`: every `notify.open` read the file and sent its complete contents even when unchanged. Incremental synchronization used a valid whole-document replacement range. The document record retained every opened full text until shutdown and never sent `didClose`.

The fix keeps whole-document replacement for real changes and reads the file to compare its actual contents. It deliberately does not use a stat-only freshness shortcut (which can miss same-size edits or restored timestamps), text diff, or a hash cache.

- Identical text preserves the document version and cached diagnostics and sends neither `didChange` nor watched-file notifications.
- A per-client LRU limits idle open documents to **64 documents / 8 MiB of UTF-16 text accounting**, whichever is reached first. This supports a multi-file editing working set while preventing a read/scan from retaining an entire repository. Counting two bytes per JS code unit conservatively covers string payloads, rather than assuming one-byte ASCII storage; object overhead is separately bounded by the document count.
- Eviction sends `didClose`, removes retained text and freshness/diagnostic state, and subsequent access sends `didOpen`. Opening an existing file is reported as a watched-file change, not filesystem creation. The idle trim is supplemented by trimming before the next open, so continuous scans cannot postpone all eviction until their end.
- A client-wide increasing version counter distinguishes document lifetimes without an unbounded per-path tombstone map. Versioned pushes for older snapshots are rejected. Pull responses for superseded document versions are discarded and the wait retries against the current version.
- Opens are serialized through their file read and notifications. No-op touches update recency. Active diagnostic waits and document RPCs pin their documents; workspace/unknown RPCs pin the working set. A raw connection request automatically reopens an evicted target (`textDocument.uri` and call hierarchy `item.uri` consumers were inspected in `lsp.ts`). Pins persist through actual RPC settlement, including identifier pulls that continue after an early matching result or a wait timeout.
- Wait freshness is anchored to the last real content notification, not the latest read. Existing **unversioned** diagnostics satisfy a no-op wait; a server that never publishes gets one bounded wait per version rather than another five seconds on every read. Newly registered pull capabilities still run. An edit during an existing wait supersedes its old version.
- A deferred idle trim allows the existing `await notify.open(); await waitForDiagnostics()` consumer to pin even an oversized file before it closes. Oversized content remains available while needed and is evicted when idle. A delayed wait can reopen an already-evicted document.
- Shutdown cancels diagnostic/registration waits, rejects queued/new opens and requests, closes documents, attempts the LSP shutdown/exit handshake with a one-second shutdown-request timeout, disposes the connection, clears retained state, and stops the process.

## Repeatable benchmark

`test/lsp/documents.bench.ts` calls the real `LSPClient` against a local stdio JSON-RPC fixture. No client implementation is duplicated in the benchmark. The fixture tracks actual `didOpen`, `didChange`, `didClose`, watched-file notifications, full-text bytes received, open documents, retained UTF-8 text bytes, high-water marks, and protocol-order violations.

Workload per trial:

1. Precreate 320 files, each 102,400 ASCII bytes.
2. Open one file, then read/touch it unchanged another 200 times, sequentially.
3. Open the other 319 distinct files, sequentially.
4. Touch the last file unchanged and wait for document diagnostics (the fixture only pushes on actual content notifications and uses **unversioned pushes**).
5. Shut down the client and fixture.

Each run has one excluded warmup and **three measured trials**. Timings exclude file creation, client initialization, lock acquisition, and shutdown. Counters for the many-document phase are cumulative; its duration measures just the 319 new documents and the final protocol barrier. The exact same benchmark/workload was run before runtime edits and after the final implementation. Later fixture additions only provide extra regression-test controls; default benchmark behavior is unchanged.

### Results

Times are medians of the three measured trials. Deterministic counts were identical across all four trials of each run.

| Metric                                             |        Before | After (final) |
| -------------------------------------------------- | ------------: | ------------: |
| Repeated-read duration                             |     122.91 ms |      14.75 ms |
| Repeated-read `didOpen` / `didChange` / `didClose` |   1 / 200 / 0 |     1 / 0 / 0 |
| Repeated-read watched notifications                |           201 |             1 |
| Repeated-read full-text bytes                      |    20,582,400 |       102,400 |
| Many-document phase duration                       |     323.18 ms |     171.27 ms |
| Cumulative `didOpen` / `didChange` / `didClose`    | 320 / 200 / 0 | 320 / 0 / 280 |
| Cumulative full-text bytes                         |    53,248,000 |    32,768,000 |
| Final open documents                               |           320 |            40 |
| Final retained text bytes (server proxy, UTF-8)    |    32,768,000 |     4,096,000 |
| Peak open documents                                |           320 |            41 |
| Peak retained text bytes (server proxy, UTF-8)     |    32,768,000 |     4,198,400 |
| No-op diagnostic wait                              |     152.36 ms |     149.29 ms |
| Protocol violations                                |             0 |             0 |

Unchanged-read wire text fell **99.5%**; final retained-text proxy fell **87.5%**. The final fixture working set is 40 files because UTF-16 accounting reaches the byte budget before the 64-document limit. The peak includes one document being handed to its caller before trimming. Diagnostic waits retain the existing 150 ms push debounce, rather than timing out for a nonexistent new push.

The retained-text metric is an explicit **protocol/server state proxy**, not a retained-heap or RSS measurement. The client stores one corresponding full text per open document, but UTF-16 accounting, JS string representation, diagnostics, object overhead, transport buffers, and GC are different quantities. No claim about total process RSS is made. Synthetic fixture latency does not predict every real language server's analysis cost; avoided notifications and bytes are the primary evidence.

### Raw outputs and lock accounting

Under `/tmp/opencode/perf-batch/lsp-documents-results/`:

- `before.json`: original pre-runtime-change run.
- `after.json`, `after.json.lock.json`: intermediate run (196 ms lock acquisition plus wrapper startup).
- `after-final.json`, `after-final.json.lock.json`: final run used above (190 ms lock acquisition plus wrapper startup).

All benchmark runs used `flock /tmp/opencode/perf-batch/bench.lock`. The first baseline invocation did not separately record lock wait; its workload timers still start after acquisition. That missing baseline lock-wait measurement is not inferred from wall-clock totals. The after wrapper reports lock wait separately from the measurements above.

### Exact commands

Run from `/tmp/opencode/perf-batch/lsp-documents/packages/opencode`.

Original baseline command (before any runtime edits):

```sh
flock /tmp/opencode/perf-batch/bench.lock env LSP_BENCH_OUTPUT=/tmp/opencode/perf-batch/lsp-documents-results/before.json bun test ./test/lsp/documents.bench.ts
```

Final after command, including separate lock accounting:

```sh
env LSP_BENCH_LOCK_REQUESTED_MS="$(date +%s%3N)" LSP_BENCH_OUTPUT=/tmp/opencode/perf-batch/lsp-documents-results/after-final.json flock /tmp/opencode/perf-batch/bench.lock bun -e 'const lock = {lockWaitMs: Date.now() - Number(process.env.LSP_BENCH_LOCK_REQUESTED_MS)}; console.log(lock); await Bun.write(process.env.LSP_BENCH_OUTPUT + ".lock.json", JSON.stringify(lock)); const run = Bun.spawn(["bun", "test", "./test/lsp/documents.bench.ts"], {stdout: "inherit", stderr: "inherit"}); process.exit(await run.exited)'
```

Regression suite:

```sh
bun test ./test/lsp
```

Result: **69 passed, 0 failed, 112 assertions** (six test files). The benchmark separately passed. Test preload and temporary-directory fixtures isolate configuration, database, and documents from real user data. One intermediate verification attempt encountered shared `/tmp` inode exhaustion; a later run proceeded after that pressure cleared. A subsequent missing-logger-import failure was corrected before the passing suite and final benchmark.

Coverage includes unchanged/unversioned diagnostics, stable versions, 20 concurrent touches, UTF-16 incremental replacement range, count LRU and recency, byte limits, oversized close/reopen, delayed raw RPCs, early-result/slow-identifier pulls, registration during waits, concurrent edits, stale versioned pushes, stale pull responses, silent-server no-op waits, and shutdown notifications/cancellation. Existing client, lifecycle, index, launch, and root tests also pass. Combined package typechecking/build/deployment remains with the parent per the assignment contract.

## Scope, changed paths, and residual risks

Changed runtime path:

- `packages/opencode/src/lsp/client.ts`

New paths:

- `packages/opencode/test/fixture/lsp/documents-server.ts`
- `packages/opencode/test/lsp/documents-fixture.ts`
- `packages/opencode/test/lsp/documents.bench.ts`
- `packages/opencode/test/lsp/documents.test.ts`
- `specs/perf-lsp-documents.md`

No changes to `lsp.ts`, its diagnostics consumer/filtering, the client diagnostics getter, apply-patch batching, or public Protocol/HttpApi. Integration overlap is confined to the surrounding client diagnostics freshness helpers and notification handler; the other agent's getter edits should remain separable.

Limits are intentionally **idle working-set limits**, not hard admission limits: required active documents, one oversized active file, or a workspace RPC can temporarily exceed them. A server RPC that never settles can retain its pin until shutdown; the existing diagnostic timeout does not cancel the underlying RPC. Eviction does not attempt to truncate source text or close documents while their RPCs still run. Server diagnostic caches for arbitrary workspace files are outside this full-text budget and remain another ownership concern.

Versionless late server pushes cannot identify the snapshot or open/close lifetime they describe; ordered notifications and fresh pulls are respected, and stale **versioned** pushes are rejected. Eviction follows LSP close semantics, so closed-document diagnostic state may be cleared; reopening discards previous lifetime freshness and obtains current results. A broader workspace-wide persistent diagnostic cache is not introduced here.

The client still rereads files on touches and still sends full replacement text for actual edits. Those choices preserve exact change detection and existing synchronization behavior. No commit, package installation, build, or deployment was performed.

## Integration correction: patch diagnostic retention

The six approved paths were integrated into `/tmp/opencode/perf-batch/integration` with the helper envelope `/tmp/opencode/perf-batch/lsp-documents-integration.patch` and its SHA256 manifest. All six post-merge hashes matched. The three-way `client.ts` merge preserved diagnostic-metadata's `diagnosticsFor`, `diagnosticFiles`, and `hasDiagnosticErrors` accessors.

The parent's real apply-patch/stdio regression reproduced a cross-fix bug: an 80-file patch returned only **64** diagnostic entries because the tool collected its cache once after all waits. `apply_patch.ts` now captures each target's scoped diagnostics immediately after its wait, then merges snapshots in deterministic target order. Normalized duplicate targets remain serialized, duplicate metadata entries remain intact, concurrency remains eight, and interruption still cancels queued work without partial success.

A stronger test uses three files larger than 4 MiB each and both fast and slow servers. It reproduced a second loss (one server's diagnostic instead of both). The correction in `client.ts` has two parts:

- Protect the open-to-wait handoff for one event-loop turn even from eager trimming in an already-queued open.
- On eviction of a document whose diagnostic wait completed, retain a **diagnostic-only snapshot**, capped at 64 entries and expiring after 10 seconds. This covers a faster server closing an oversized file while the consumer still waits on another server. These snapshots retain no source text or document objects, are invalidated on reopen, and are cleared with their timers on shutdown. All three metadata accessors remain available and include these transient results consistently.

The additional retention is bounded by entry count and lifetime, not diagnostic payload bytes; diagnostics themselves can contain arbitrarily large server-provided messages. It does not weaken the source-text budget. Capturing results per file remains necessary for patches exceeding the combined active/transient working set. Unrelated work can exhaust the bounded transient cache, and snapshots are not promised after the ten-second handoff window.

Patch tests now validate increasing global versions against the real server's document state and require zero `didChange` notifications for repeated unchanged targets. The patch benchmark's correctness assertions were updated similarly; the long benchmark was not rerun. The fixture now handles `didClose` and emits bounded first-line diagnostic messages so oversized-source tests are meaningful. A client regression covers 144 completed documents, the retained-text limit, diagnostic handoff count eviction, accessor consistency, reopen invalidation, and shutdown cleanup.

The existing outside-instance LSP test now creates its own Git repository: under the requested `TMPDIR`, a directory without its own Git root otherwise inherits the main checkout's worktree, making its supposed outside path legitimately inside that worktree.

Additional changed integration paths:

- `packages/opencode/src/tool/apply_patch.ts`
- `packages/opencode/test/tool/patch-diagnostics.test.ts`
- `packages/opencode/test/tool/patch-diagnostics.bench.test.ts`
- `packages/opencode/test/tool/patch-document-retention.test.ts` (parent-created, extended here)
- `packages/opencode/test/fixture/lsp/patch-diagnostics-server.js`
- `packages/opencode/test/lsp/index.test.ts`

Integration verification, from `integration/packages/opencode`:

```sh
TMPDIR=/home/shawn/code/opencode/node_modules/.cache/perf-tests bun test ./test/tool/patch-diagnostics.test.ts ./test/tool/diagnostic-metadata.test.ts ./test/tool/patch-document-retention.test.ts ./test/lsp
```

Result: **82 passed, 0 failed, 407 assertions** across nine files. `git diff --check` also passed. Original comparative benchmark results above are unchanged historical measurements; no new performance claim is made for this correctness-only integration adjustment. Combined typechecking/build/deployment remain parent-owned.

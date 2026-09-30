# Performance batch: eight measured changes

Each item was developed in an isolated worktree from shared tree
`e6f0f15a59125fb1775dd081da144ec16c4622aa`, including the existing local changes.
Before measurements preceded implementation. The reports below describe the
fixtures, commands, warmups, sample counts, correctness checks, and limitations.
Benchmarks used Bun 1.4.2 on an AMD Ryzen 9 5950X and were serialized with a shared
lock. These are per-workload measurements, not an aggregate application speedup.

## Representative results

| Change | Workload / metric | Before | After |
| --- | --- | ---: | ---: |
| Scoped sharing listeners and lazy payloads | Unshared publications after 20 instance reloads | 121.76 ms | 25.92 ms |
| Bounded parallel patch diagnostic waits | 12 files, slow real stdio LSP fixture | 4,889 ms | 858 ms |
| File-scoped diagnostic metadata | Apply Patch metadata with 10,000 unrelated files | 70,168,967 bytes | 2,247 bytes |
| Native bounded-context snapshot patches | Small edit in an 8 MB tracked file | 8,100,234 patch bytes | 797 patch bytes |
| Bounded LSP documents and unchanged-text suppression | 200 unchanged reads | 122.91 ms | 14.75 ms |
| Coalesced summaries and targeted database reads | 33 summary requests, 242-message session | 297.848 ms | 78.123 ms |
| Reuse completed snapshot trees | Completion scan commands | 4 | 2 |
| Cache negative formatter discovery | Sequential process-probe workload | 94.70 ms | 5.49 ms |

Latency rows use medians except patch waits, which use means of two trials.
Additional deterministic reductions include sharing listeners 105→5, unchanged
LSP `didChange` notifications 200→0, summary SQL statements 861→264, and formatter
discovery calls 360→3. Snapshot latency also improved in measured trials: the 8 MB
case changed from 148.657→114.289 ms and the 120-file case from 278.648→183.962 ms.
The final summary benchmark overlapped snapshot-race correctness tests, limiting
wall-time comparisons; its deterministic work counts remained unchanged.

## Tradeoffs and scope

- Some cheap cases regressed: formatter missing-config sequential discovery
  7.17→15.27 ms, missing-dependency concurrent discovery 6.23→7.70 ms, and snapshot
  completion with a small edit among 1,000 files 30.09→33.46 ms. Sharing initial
  checkpoints, snapshot warmups, and the single-file slow-LSP case also regressed
  in individual reports. These results are retained rather than averaged away.
- Snapshot patches bound unchanged context, retaining every changed line. They
  do not impose a hard output limit on large changed content. Partial-hunk comment
  previews are supported; arbitrary historical-context expansion is not added.
- LSP text retention is bounded by 64 documents and 8 MiB of UTF-16 content per
  client when idle. Active work may temporarily exceed those limits. Versionless
  diagnostic pushes cannot prove which source snapshot produced them.
- Summaries still query session metadata to identify children; the change avoids
  hydrating unrelated transcript bodies, without making all work constant-time.
  Its timing fixture controls the Snapshot boundary; it is not a Git benchmark.
- Formatter negatives expire after five seconds. Expensive probes improve most;
  cache bookkeeping can outweigh very cheap discovery work.
- Memory readings are process-lifetime peaks/proxies where specified, not isolated
  allocation measurements. Lock/startup overhead is reported separately and is
  not included in measured operation times.

## Detailed reports

1. [Sharing](perf-sharing.md)
2. [Patch diagnostics](perf-patch-diagnostics.md)
3. [Diagnostic metadata](perf-diagnostic-metadata.md)
4. [Snapshot size](perf-snapshot-size.md)
5. [LSP documents](perf-lsp-documents.md)
6. [Summaries](perf-summaries.md)
7. [Snapshot scans](perf-snapshot-scans.md)
8. [Formatters](perf-formatters.md)

## Review corrections

- Snapshot patch generation overrides `diff.suppressBlankEmpty` locally so user
  Git settings cannot break reconstruction and comment-preview coordinates.
- Summary cache revisions are captured before computation starts, preventing a
  same-tree request during computation from accepting stale ignore-dependent
  output. The failing-before regression passes with the correction; summary
  timing above comes from the corrected implementation.
- Summary workers await their completion as an Exit before propagating failure,
  avoiding an Effect completion-observer interaction that could hang instance
  teardown. A latch-controlled regression failed before this correction and
  passed afterward; the previously intermittent snapshot/tool-race test also
  passed ten consecutive runs. The summary suite passed 17 tests / 54 assertions.
- Large patches collect diagnostics after each document wait, before subsequent
  documents can evict earlier results. A bounded diagnostic-only handoff preserves
  results when fast and slow servers finish oversized documents at different times.
  Real regressions cover 80-file patches and three oversized files with two servers.
  The original standalone LSP/patch timings predate this correctness adjustment.

## Combined verification

The integration checkout passed the following package-local checks:

- Opencode sharing, formatting, snapshots, summary, processor, snapshot/tool-race,
  and revert/compaction suites: **138 passed, 2 skipped, 0 failed; 1,322 assertions**.
- Session-UI diff and Apply Patch file consumers: **14 passed, 0 failed; 44 assertions**.
- `bun typecheck` in `packages/core` and `packages/session-ui`: passed.
- Combined LSP and diagnostic-tool regressions: **82 passed, 0 failed; 407 assertions**.

The final performance-only candidate was also applied to a clean checkout of
`610586688e`, excluding unrelated working-tree changes. Its combined backend
suite passed **293 tests, 2 skipped, 0 failed; 1,878 assertions across 23 files**,
followed by a successful `bun typecheck` in `packages/opencode`. Isolated
Session-UI checks had already passed **14 tests / 44 assertions** and typechecking;
the subsequent lifecycle correction only changed backend summary code and tests.
The final main-checkout build, including the embedded web UI, passed its native
binary version smoke test (`0.0.0-shawnd-202609301059`).

Filesystem-heavy correctness tests used a disk-backed temporary directory to
avoid the system `/tmp` inode limit. Comparative benchmarks retained their
original storage and fixtures.

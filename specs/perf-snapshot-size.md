# Snapshot diff context amplification (table item 4)

## Baseline and scope

- Baseline tree: `e6f0f15a59125fb1775dd081da144ec16c4622aa` (the worktree index, **not HEAD**).
- Worktree: `/tmp/opencode/perf-batch/snapshot-size`.
- Measured on Linux with Bun `1.4.2 (744846f84)` using real isolated Git repositories and the real `Snapshot.Service.diffFull`.
- Runtime scope: `Snapshot.diffFull` and its session-review consumers. Capture, track, patch, restore, revert, processor completion, and `session/summary.ts` are not edited.

The finding is confirmed. The baseline fetched before/after blob contents in batches of 100 **files**, with no byte budget, decoded them into JS strings, and ran jsdiff with `context: Number.MAX_SAFE_INTEGER`. A one-line edit therefore persisted nearly an entire file as a user-summary patch. The existing 2 MiB capture cutoff excludes only untracked large files; already tracked large files still participate. The benchmark explicitly stages its initial files before snapshot capture to exercise this path.

## Consumer investigation and implementation

`packages/session-ui/src/components/session-diff.ts` distinguishes complete full-context snapshot/Git patches from ordinary partial unified patches. Complete patches are reconstructed into before/after files; partial patches are parsed by Pierre with `isPartial: true`, source line numbers, and omitted ranges. Both review generations already select partial hunk separators and cannot expand unavailable context. There is no historical-snapshot lazy-detail API. The current-worktree file reader is not a safe substitute for historical contents.

The fix uses these existing semantics:

1. Read raw NUL-delimited Git records with full object IDs; ask `cat-file --batch-check` only for sizes. No complete blob-content batch enters JS.
2. Generate the patches in native Git, with text conversion/external diff/renames/color disabled. Exact addition/deletion counts still come from Git numstat, and binary patches remain empty with zero counts.
3. Retain full context for files whose **sum of before/after blob bytes is at most 262,144 bytes (256 KiB)**, subject to a **4,194,304-byte (4 MiB) aggregate full-context input budget per call**. The existing full-context Git header tells consumers these are complete files.
4. Otherwise request **three context lines**. Preserve **every changed line**, hunk offset, and no-final-newline marker. Format an ordinary unified-patch header without the full-context marker. Even a single hunk starting at line one remains partial; it must never be reconstructed as a complete file.
5. Batch adjacent files with the same context mode, at most **100 files** and **8,388,608 before/after input bytes (8 MiB)**. A single file larger than that is processed alone. Processing remains sequential under the existing snapshot lock and uses the existing Effect-aware process lifetime/cancellation handling.
6. Fix both review generations' comment previews to translate file line numbers through partial hunk offsets, rather than index concatenated hunk lines as if they were whole files. Omitted selections return no preview instead of unrelated text. Preserve authoritative enclosing filenames when patch parsers split/unquote unusual names.

The established public filename representation is preserved: Git-quoted names from numstat are returned, while raw NUL-delimited paths are used internally for object lookup, ignore checking, and literal pathspecs. This is important because `SessionSummary.diff` already decodes Git-quoted names, including filenames literally beginning/ending with quotes. Numstat and raw records have identical ordering; record count mismatches fail rather than silently omitting files. No changes to the summary agent's file are needed.

Other consumers reviewed: TUI revert parsing reads hunk changes (and uses the separate undo diff); web share `ContentDiff` is used for tool metadata, not these user-summary snapshot patches. Existing session-turn/message rendering uses the shared session-diff adapter. Full unchanged context remains available for ordinary small diffs; large-file review shows a normal partial diff with all changes. Snapshot object contents and undo remain intact.

No public Schema, Protocol, Server HttpApi, or SDK type was changed. Client/SDK regeneration is therefore not required. A future hard-cap/lazy-detail design would need immutable snapshot-backed detail retrieval, explicit incomplete/loading semantics, historical-object retention rules, both review generations and sharing/client consumers, API schema changes, and generated-client/legacy-SDK regeneration; it cannot safely substitute a current-worktree read or silently empty a patch.

## Repeatable benchmark

Added `packages/opencode/test/snapshot/snapshot-size.bench.ts`. The identical benchmark ran before runtime edits and after them. It creates isolated Git repositories through the existing test fixtures/preload (isolated XDG/config/database), builds before/after snapshots outside the timed region, then times actual `snapshot.diffFull(before, after)` calls.

Workloads:

| Fixture         | Files | Lines per original file | Original bytes total |                 Changed lines |
| --------------- | ----: | ----------------------: | -------------------: | ----------------------------: |
| `large-tracked` |     1 |                 100,000 |            8,000,000 |       1 addition + 1 deletion |
| `many-tracked`  |   120 |                   2,000 |           19,200,000 | 120 additions + 120 deletions |

Each line is a zero-padded eight-digit line index, a space, 70 `x` characters, and a newline (80 bytes). The middle line's index is changed to `changed!`. The multi-file workload spans the original 100-file batch boundary. Both snapshots retain exactly equal file byte sizes. Every trial asserts the returned file count and exact numstat counts.

One warmup plus **three measured trials per fixture**. `Bun.gc(true)` precedes each call. Timing excludes fixture setup, capture, forced GC, JSON serialization, and assertion work. Output counts cover both raw patch UTF-8 bytes and complete `JSON.stringify(diffs)` UTF-8 bytes (the representation subsequently persisted in summaries).

Commands, from `/tmp/opencode/perf-batch/snapshot-size/packages/opencode` (create the results directories before running):

```bash
started=$(date +%s%3N) && flock /tmp/opencode/perf-batch/bench.lock env BENCH_REQUESTED_AT="$started" SNAPSHOT_SIZE_RESULTS=/tmp/opencode/perf-batch/snapshot-size-results/before bun test ./test/snapshot/snapshot-size.bench.ts
started=$(date +%s%3N) && flock /tmp/opencode/perf-batch/bench.lock env BENCH_REQUESTED_AT="$started" SNAPSHOT_SIZE_RESULTS=/tmp/opencode/perf-batch/snapshot-size-results/after-final bun test ./test/snapshot/snapshot-size.bench.ts
```

The first command must run on the baseline tree with the benchmark file added but before runtime edits. Do not reset this worktree to HEAD: its index contains shared baseline changes.

### Final results

| Fixture           | Median wall ms before → after | Patch bytes before → after | JSON bytes before → after | Process lifetime max RSS KiB before → after |
| ----------------- | ----------------------------: | -------------------------: | ------------------------: | ------------------------------------------: |
| large tracked     |             148.657 → 114.289 |            8,100,234 → 797 |           8,200,327 → 895 |                           519,344 → 498,904 |
| 120 tracked files |             278.648 → 183.962 |        19,467,600 → 95,160 |      19,718,641 → 106,801 |                           778,896 → 501,508 |

Exact wall-time samples in milliseconds (warmup separated):

| Fixture/run       |     Warmup | Measured trial 1 | Measured trial 2 | Measured trial 3 |
| ----------------- | ---------: | ---------------: | ---------------: | ---------------: |
| large before      | 160.352379 |       148.656924 |       171.136427 |       112.170206 |
| large final after | 342.476582 |        97.610300 |       114.289497 |       119.078725 |
| many before       | 312.920298 |       320.029039 |       267.004985 |       278.647960 |
| many final after  | 479.667798 |       187.309775 |       177.148580 |       183.962330 |

Patch reduction is **99.990%** for the large file and **99.511%** for the many-file case. Final median wall time improves approximately **23%** and **34%** respectively. Warmups became slower, so this is not a claim of uniform cold-call speedup.

Raw per-trial results (including RSS before/after every call and process lifetime maxRSS) are saved under `/tmp/opencode/perf-batch/snapshot-size-results/`:

- `before/{large-tracked,many-tracked}.json`: actual pre-edit baseline.
- `after/{large-tracked,many-tracked}.json`: first implementation run, retained rather than discarded; same output sizes, median times 102.424/166.660 ms.
- `after-final/{large-tracked,many-tracked}.json`: final filename-compatible implementation, used in the table.
- `runs.json`: run timing/log provenance and environment notes.

All benchmark processes used the shared flock. The separately logged **lock wait plus Bun/preload/module startup** was 1,159 ms before, 71,018 ms for the first after run, and 1,413 ms for the final after run; that time is not included in any timed diff call. Pure lock wait was not instrumented separately from startup and should not be inferred from these totals.

RSS is noisy and is **not retained heap or per-call peak memory**: maxRSS includes runtime startup, fixture creation/capture, earlier trials, and earlier fixtures, and excludes native Git child-process peaks. Endpoint RSS can fall during a call due to background collection. Other agents' tests can run concurrently even though benchmarks are serialized; our final correctness suite also ran concurrently with the final benchmark. The deterministic eliminated blob-transfer/full-context bytes are stronger evidence than a small RSS/timing difference. An intermediate test launch and final-benchmark directory creation hit transient `/tmp` ENOSPC before tests ran; after space became available, both reran successfully. No other agent's files were deleted.

## Correctness checks

Commands from `packages/opencode`:

```bash
bun test ./test/snapshot/snapshot.test.ts ./test/snapshot/snapshot-size.test.ts
```

Result: **59 pass, 1 existing skip, 0 fail; 954 assertions**.

New actual-service regression coverage:

- A >2 MiB tracked file with beginning/middle/end edits; bounded patch bytes, exact 3/3 counts, patch application reconstructs the entire new file, source-line comment previews on both sides, omitted ranges, missing final newline, and snapshot restore verifies both historical contents byte-for-byte.
- Normal full-context files with CRLF, Unicode/mixed RTL-LTR content, no final newline, tab/newline/space names, literal pathspec metacharacters, and names containing literal quotes. Windows excludes filesystem-invalid names.
- Forty individually small files that exceed the aggregate eager budget; full then partial modes, leading-only partial hunks, accurate ordering/counts, unusual filenames, patch application, and consumer metadata/selection checks for every file.
- Oversized additions and deletions: **all 40,000 changed lines** survive; patches apply in both directions without truncating payloads to a size target.
- The existing suite covers binary behavior, mixed changes, >100-file ordering, ignore handling, capture/revert, locks and worktrees.

Commands from `packages/session-ui`:

```bash
bun test src/components/session-diff.test.ts src/components/apply-patch-file.test.ts
```

Result: **14 pass, 0 fail; 44 assertions**. Includes partial hunk source-offset previews, reversed ranges, additions/deletions with shifted line numbers, missing-final-newline complete contents, omitted selections, existing full/partial/headerless patch compatibility, and apply-patch consumers. The producer regression tests import the real session-diff adapter, rather than reimplementing its full/partial heuristic.

Prettier run on changed TypeScript files; `git diff --check` passes. Package-wide typechecks, combined integration, build, installation and deployment are left to the parent per the batch contract. No commits or dependency installation were performed.

## Limits, tradeoffs, and remaining work

- The budgets limit **unchanged-context amplification**, not total required changed content. A wholesale replacement, huge addition/deletion, or a very long changed/context line can still produce a large patch. File metadata also scales with file count. Imposing an absolute output cap without a historical detail API would drop required information.
- Native Git must still read/diff the relevant source objects; a single huge file can use substantial native memory/CPU. The 8 MiB batch rule has an explicit single-file exception and is not a process RSS limit.
- Large-file unchanged regions cannot be expanded from these stored partial patches. Every change remains available; captured file contents/undo are preserved. Existing stored full patches are not migrated or compacted.
- Native Git and jsdiff may choose different valid alignments for ambiguous/repeated lines. Stats are authoritative Git counts and patches are checked by application, not string equality with jsdiff.
- Git-quoted filenames remain the existing summary transport convention. The summary agent should retain its legacy decoder. A pre-existing decoder limitation for combined quoted control characters and non-ASCII characters is outside this diff-generation change; this implementation does not introduce a new filename convention or broaden that decoder.
- No CSS, direction, focus, or physical-coordinate behavior changed; mixed-script data is covered by tests, but browser LTR/RTL visual testing was not run.

## Changed paths and integration overlaps

- `packages/opencode/src/snapshot/index.ts`: imports/constants and `diffFull` only; the snapshot-scans agent edits other functions in the same file. Merge by function, not whole-file replacement.
- `packages/opencode/test/snapshot/snapshot-size.bench.ts` (new).
- `packages/opencode/test/snapshot/snapshot-size.test.ts` (new).
- `packages/session-ui/src/components/session-diff.ts`.
- `packages/session-ui/src/components/session-diff.test.ts`.
- `packages/session-ui/src/components/session-review.tsx`.
- `packages/session-ui/src/v2/components/session-review-file-preview-v2.tsx`.
- `specs/perf-snapshot-size.md` (this file).

No changes to `session/summary.ts`; its existing persistence path receives the reduced ordinary patch payload. No generated-client files are touched.

## Parent review follow-up: Git presentation settings

Verified with Git `2.55.0` using an additional real Snapshot + real session-diff integration regression, covering both small full-context and oversized partial patches with unchanged blank lines.

- **Confirmed regression before the fix:** with `diff.suppressBlankEmpty=true` in the isolated snapshot repository's config, native Git emits unprefixed empty context lines. Pierre reports invalid raw lines, and the real partial selection preview for source lines 2–3 incorrectly returned `new\nlast` instead of `\nnew`. The targeted pre-fix test failed at that consumer assertion (0 pass, 1 fail, 4 filtered out).
- **Fix:** add command-local `-c diff.suppressBlankEmpty=false` only to the native patch-emission command inside `diffFull`. Raw/stat/size queries and other Snapshot/Git operations retain their settings. The regression verifies exact counts, standard blank-line prefixes, patch application, complete-file reconstruction, partial/full classification, and both sides' source-line previews. A subsequent direct Git diff still exhibits the configured suppressed blank prefixes, proving that no repository preference was mutated by `diffFull`.
- **Custom indicators:** the native probe verifies that `--output-indicator-new=>`, `--output-indicator-old=<`, and `--output-indicator-context=.` produce `>new`, `<old`, and `.first` respectively. These are supported command-line options, not user-configurable defaults in Git 2.55's [diff config documentation](https://github.com/git/git/blob/v2.55.0/Documentation/config/diff.adoc). `diffFull` constructs its own argument array, takes only snapshot IDs, and does not accept those presentation options or invoke a shell alias/external diff. Therefore no speculative indicator config/flag overrides were added; without those options the direct native probe emits standard `+`, `-`, and space indicators even with blank suppression enabled.

Post-fix command, from `packages/opencode`:

```bash
TMPDIR=/home/shawn/code/opencode/node_modules/.cache/perf-tests bun test ./test/snapshot/snapshot-size.test.ts
```

Result: **5 pass, 0 fail, 241 assertions**. Fixtures use the parent's requested recovered-inode test storage. Earlier full-suite results above remain historical, not claims of a second full-suite run. Comparative benchmarks were not rerun: the sole runtime change forces Git's default `false` value for a setting absent from those fixtures, so their default-config output and work are unchanged. This follow-up stays within the same eight changed paths.

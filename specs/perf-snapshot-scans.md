# Item 7: reuse the completed snapshot tree

## Baseline and scope

- Assignment: `snapshot-scans`, table item 7.
- Baseline **tree**: `e6f0f15a59125fb1775dd081da144ec16c4622aa` (the shared index, including the user's pre-existing changes; HEAD is older).
- Assigned worktree: `/tmp/opencode/perf-batch/snapshot-scans`.
- Runtime changes: `packages/opencode/src/snapshot/index.ts` and the step-finish call site in `packages/opencode/src/session/processor.ts`.
- No public Protocol/HttpApi change. The additional argument is internal to the Snapshot service.

## Mechanism and fix

`SessionProcessor` captures `completedSnapshot = snapshot.track()` at step finish. Previously it then called `snapshot.patch(ctx.snapshot)`, which invoked `add()` again under the same snapshot-repository semaphore. Each `add()` synchronizes excludes and runs `diff-files` plus `ls-files` against the scoped worktree.

**Correction to the audit:** the duplicate `add()` normally rescans but does **not** issue a second `git add`: the completed capture has already staged the edit. Actual subprocess instrumentation confirms zero staging commands for no edits and one staging command for a small edit, both before and after the fix.

`patch(hash, completed?)` now compares the two immutable trees when the completion tree is supplied. It retains the original `hash` in the returned patch for undo. The processor supplies the tree it already recorded in its step-finish part. No cache or additional tree capture is introduced.

- The completed-tree path does not read or modify the shared index. Intervening captures cannot change its changed-path set.
- Tree comparisons use `--no-renames`, so both the old and new paths are available to undo a rename. The old one-argument fallback keeps its existing Git options and behavior.
- Existing invoking-directory pathspec scope and current source-repository ignore filtering remain in place. Ignore rules are intentionally still evaluated at patch time, as before; the immutable boundary applies to compared file contents/path changes, not to a frozen copy of ignore configuration.
- Missing/empty completion hashes use the existing scan-and-cached-diff path. A failed tree comparison logs and retries that path. An invalid original baseline still returns an empty patch after Git fails, matching existing behavior.
- Scan, ignored-path removal, stage, or write-tree failure must not publish a stale completed tree. `add()`/`stage()`/`drop()` now report success internally and `track()` returns `undefined` on those failures, enabling the fallback to retry. Disabled snapshots retain the existing `undefined` result.
- The semaphore and interruptible subprocess execution remain in place. Interrupted processor cleanup still calls the one-argument current-worktree patch path.

## Benchmark

The opt-in `packages/opencode/test/snapshot/scans.bench.test.ts` exercises the **real Snapshot service**, AppProcess implementation, and Git in isolated repositories. Its AppProcess decorator records command argument arrays and delegates every command unchanged. It measures the actual completion snapshot sequence (`track()` followed by `patch(original, completed)`), with separate track/patch/total wall times. On the baseline the extra JS argument is ignored. The exact same benchmark fixture/code was used after the runtime edit; later changes to the benchmark file were formatting only.

Workloads:

- 100, 1,000, and 10,000 small text files, each with deterministic contents and filenames.
- No edits, or one modified existing text file per trial.
- One initial capture populates the snapshot index. Each trial prepares its baseline outside the measured interval. Git init, fixture creation, config loading, and teardown are excluded.
- Two warmups and seven recorded trials **per file-count/workload combination**, 42 recorded trials per phase.
- Identically constructed fresh isolated repositories in each phase; original temporary paths are retained in the command arrays in the raw data. Test preload isolates XDG/config/database state.
- Linux, Bun 1.4.2. Both measurements were serialized with the batch's shared `flock`.

### Results

Times below are medians in milliseconds; command counts were identical in all seven trials in each row. Track and patch medians are independent and need not sum to the total median.

| Files | Edit | Track before → after | Patch before → after | Total before → after | Git commands before → after | Scan commands before → after | Stages before → after |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | none | 8.91 → 12.51 | 9.00 → 3.77 | 17.87 → 17.25 | 8 → 5 | 4 → 2 | 0 → 0 |
| 100 | one file | 16.64 → 16.32 | 10.22 → 4.91 | 27.05 → 21.46 | 12 → 9 | 4 → 2 | 1 → 1 |
| 1,000 | none | 15.75 → 8.23 | 15.20 → 2.83 | 30.08 → 10.98 | 8 → 5 | 4 → 2 | 0 → 0 |
| 1,000 | one file | 20.12 → 21.26 | 10.63 → 6.31 | 30.09 → 33.46 | 12 → 9 | 4 → 2 | 1 → 1 |
| 10,000 | none | 13.59 → 13.48 | 13.41 → 2.49 | 27.18 → 15.82 | 8 → 5 | 4 → 2 | 0 → 0 |
| 10,000 | one file | 60.57 → 61.11 | 18.42 → 7.56 | 79.37 → 69.94 | 12 → 9 | 4 → 2 | 1 → 1 |

The stable result is **50% fewer worktree scan subprocesses** and **three fewer Git subprocesses** per successful completion. Patch median latency improves in all six cases. Total median latency improves in five cases; the 1,000-file small-edit case regresses 11.2%. Background non-benchmark work was allowed elsewhere in the batch, and even the unchanged track operation varies. Individual total-time outliers reach 238.72 ms before and 225.53 ms after, so these wall-clock results are illustrative rather than a universal speedup claim.

Lock wait (excluded from measured intervals): **42,667 ms before**, **192 ms after**. A prior lock attempt timed out before execution, and an initial benchmark fixture attempt failed on missing test-layer ChildProcessSpawner before sampling; the test layer was corrected before either successful measurement or runtime edits.

Raw results:

- `/tmp/opencode/perf-batch/snapshot-scans-results/before.json`
- `/tmp/opencode/perf-batch/snapshot-scans-results/after.json`
- `/tmp/opencode/perf-batch/snapshot-scans-results/run-info.json`

### Reproduction

From `/tmp/opencode/perf-batch/snapshot-scans/packages/opencode`, run the following on the baseline tree with the benchmark file added, then on the modified tree, replacing `before.json` with `after.json`:

```sh
env SNAPSHOT_SCANS_OUTPUT=/tmp/opencode/perf-batch/snapshot-scans-results/before.json \
  BENCH_WAIT_STARTED="$(date +%s%3N)" \
  flock /tmp/opencode/perf-batch/bench.lock \
  bun -e 'console.log("lockWaitMs=" + (Date.now() - Number(process.env.BENCH_WAIT_STARTED))); const result = Bun.spawnSync(["bun", "test", "test/snapshot/scans.bench.test.ts"], {stdout:"inherit", stderr:"inherit"}); process.exit(result.exitCode)'
```

The benchmark is skipped without `SNAPSHOT_SCANS_OUTPUT`. Do not run package tests from the repository root.

## Correctness and checks

`test/snapshot/completed-tree.test.ts` covers:

- Add, modify, delete, rename, ignored additions and newly ignored tracked paths.
- Original undo baseline and real `revert()` restoration of both rename paths.
- A file changed during the step and restored externally after capture still belongs to the step patch; a previously untouched file modified externally after capture does not.
- A later `track()` changing the shared index does not affect the earlier completed-tree comparison.
- Equal trees exclude post-capture additions; one-argument patch still includes them.
- Current ignore rules, including an `info/exclude` update after capture.
- Scoped subdirectory capture in a linked Git worktree, including outside/late/ignored files.
- Missing, empty, invalid completion hashes; invalid original baseline; injected scan/stage/remove/write-tree failures followed by real successful fallback.
- Cancellation while the comparison holds its permit, finalizer execution, and subsequent current-worktree cleanup patch. The test gates the actual Git result deterministically rather than relying on sleeps; it does not separately test killing a live Git OS process.

`test/session/processor-effect.test.ts` additionally exercises real SessionProcessor persistence and Snapshot with a controlled external edit immediately after the completion capture. It asserts the recorded finish tree, original patch hash, exclusion of the late file, and real undo. This test failed on the baseline with the late file incorrectly included, and passes after the fix.

Executed from `packages/opencode`:

```sh
bun test test/snapshot/completed-tree.test.ts test/snapshot/snapshot.test.ts test/session/processor-effect.test.ts test/session/snapshot-tool-race.test.ts
# 80 pass, 1 existing skip, 0 fail; 856 assertions; 31.01 seconds

bun test test/snapshot/completed-tree.test.ts
# After adding the ignored-path removal failure assertions: 6 pass, 0 fail; 33 assertions

bun ../../node_modules/prettier/bin/prettier.cjs --check src/snapshot/index.ts src/session/processor.ts test/snapshot/completed-tree.test.ts test/snapshot/scans.bench.test.ts test/session/processor-effect.test.ts
# All matched files pass
```

Targeted type-aware oxlint from the assigned repository root passes with 0 errors and 14 warnings on existing code (unused bindings, consistent-return, existing assertions). Running oxlint from the package first encountered the root-only `options.typeAware` config restriction; rerunning from the repository root resolved that invocation issue:

```sh
node_modules/.bin/oxlint packages/opencode/src/snapshot/index.ts packages/opencode/src/session/processor.ts packages/opencode/test/snapshot/completed-tree.test.ts packages/opencode/test/snapshot/scans.bench.test.ts packages/opencode/test/session/processor-effect.test.ts
```

Combined package typechecking/build/deployment are delegated to the parent per the batch contract.

## Changed paths and integration notes

- `packages/opencode/src/snapshot/index.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/test/snapshot/completed-tree.test.ts` (new)
- `packages/opencode/test/snapshot/scans.bench.test.ts` (new, opt-in)
- `packages/opencode/test/session/processor-effect.test.ts`
- `specs/perf-snapshot-scans.md` (this document)

The snapshot-size agent also edits `snapshot/index.ts`; this change touches the service patch signature/forwarder, patch tree comparison, and track/add/stage/drop success propagation only. It does not change `diffFull` or its output sizing. `session/summary.ts` is untouched.

Residual limitations: the benchmark excludes full model/provider/DB/summary latency, cold startup, huge-file content hashing, and platform differences. No retained-heap claim is made: this fix introduces no cache and targets worktree I/O/process overhead. Git capture itself is not an atomic filesystem snapshot; concurrent writes during capture retain existing Git semantics. Legacy one-argument rename detection and line-based path parsing are unchanged. If a completed tree cannot be compared, fallback deliberately returns to the current-worktree boundary for compatibility/recovery. Successful completion intentionally stops attributing unrelated edits made after capture to that finished step.

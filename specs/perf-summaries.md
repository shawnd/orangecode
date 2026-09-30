# Session summary coalescing — performance item 6

## Scope and baseline

- Assigned worktree: `/tmp/opencode/perf-batch/summaries`.
- Baseline tree: `e6f0f15a59125fb1775dd081da144ec16c4622aa` (the worktree's supplied index, including the parent's existing changes).
- Runtime change: `packages/opencode/src/session/summary.ts` only.
- No schema, index, HTTP API, processor, or Snapshot implementation changes. Integration into `/tmp/opencode/perf-batch/integration` was authorized after the parent's freshness review. No commit, installation, build, or deployment was performed.

The finding was confirmed. Every `summarize` previously used `Session.messages`, paging through the complete session and hydrating all parts before filtering by user/parent ID. Overlapping calls independently computed cumulative snapshot diffs and published user-message updates. `diff` also hydrated the complete transcript to read one user's saved summary.

## Implementation

1. **Instance-scoped, per-turn coalescing.** `InstanceState` owns active entries keyed by session and user-message ID. Callers join one scoped fiber; requests arriving during work mark the turn dirty so it reloads the latest snapshot endpoints before finishing. Different turns and directories remain independent.
2. **Cancellation and failure handling.** Each caller waits for the shared result. Cancelling one waiter preserves other waiters' work; cancelling the last waiter interrupts the worker. Instance disposal interrupts workers. Failures reach all current waiters, and completed/failed/interrupted entries are removed so a later request can retry.
3. **Targeted internal reads.** The user is selected by primary key plus session ID. The snapshot query selects only snapshot/type fields of relevant user/direct-assistant step parts, ordered identically to the original message and part traversal. It does not hydrate historical text/tool bodies. `diff` directly reads the target message, retaining the missing-session error behavior.
4. **Bounded pair reuse.** `Effect.cached` retains at most one snapshot-pair result inside an active refresh. Its revision is captured before computation starts. Any newer request, including one arriving during computation, requires a fresh result even for identical tree IDs: ignore rules may already have been observed before `diffFull` returns. Nothing is retained across independent refreshes, since `Snapshot.diffFull` also depends on live ignore rules.
5. **Freshness and writes.** Endpoint revalidation detects parts removed during snapshot work. Reloading the user before publication preserves concurrently edited summary title/body and avoids resurrecting deleted users. Structurally identical diffs skip the user-message rewrite. The existing session-summary reset and empty session-diff event occur once per refresh rather than once per coalesced caller. `computeDiff`, used by revert, is unchanged.

## Benchmark

The baseline was executed **before any runtime edits**. Both sides exercise the actual `SessionSummary`, `Session`, SQLite database, event service, and session projector. Only Config and the Snapshot boundary are controlled. Each trial gets a fresh migrated in-memory database and service layer.

Fixture:

- 120 historical turns plus the current turn: 242 messages.
- Ten parts per assistant: a step start, eight 2 KiB text bodies, and a step finish. Initial total: 1,210 parts and 1,982,464 bytes of text payload.
- Start a summary and hold its `diffFull` at a latch.
- Publish 24 additional step-finish parts and launch 24 overlapping summaries while the snapshot boundary is held for 50 ms. Final total: 1,234 parts.
- Release the boundary, join every caller, then perform eight independent repeated summaries: **33 summarize calls** overall.
- Assert that the saved diff ends at `latest-23` on every trial.
- One warmup plus three measured trials per run. SQLite statement counts use Effect's `CurrentTransformer`; message writes and diff events are counted through the real event service. Snapshot calls and their endpoint pairs are recorded at the controlled boundary.
- Counts include the same 24 fixture part-update events in both versions. Setup/migrations and the final correctness read are outside the measurement window.

### Results

| Metric per trial | Before | After (freshness correction) |
| --- | ---: | ---: |
| Median wall time, including 50 ms gate | 297.848 ms | 93.809 ms |
| Measured wall-time range | 295.214–311.198 ms | 77.205–97.967 ms |
| SQL statements | 861 | 264 |
| SELECT statements | 567 | 138 |
| INSERT/UPDATE/DELETE statements | 294 | 126 |
| Snapshot `diffFull` calls | 33 | 10 |
| User-message update events | 33 | 1 |
| Empty session-diff events | 33 | 9 |

Counts were identical across all four trials on each side. Median elapsed time decreased approximately **68.5% (3.18× faster)**. The after run computes the initial and latest burst pairs, then one diff for each of the eight independent refreshes. Those independent refreshes deliberately recheck live ignore rules, but do not rewrite an unchanged user summary. The focused freshness correction left all benchmark work counts unchanged; the previously recorded after median was 83.467 ms, and is retained rather than substituted for the corrected run's timing.

Raw measurements:

- `/tmp/opencode/perf-batch/summaries-results/before.json`
- `/tmp/opencode/perf-batch/summaries-results/after.json` — initial implementation measurement
- `/tmp/opencode/perf-batch/summaries-results/after-final.json` — pre-review runtime, with completion-time revision capture
- `/tmp/opencode/perf-batch/summaries-results/after-freshness.json` — corrected final runtime, with start-time revision capture

All measurement commands were serialized with `/tmp/opencode/perf-batch/bench.lock`. The separately logged `SUMMARY_LOCK_WAIT_MS` is request-to-test-module time, **including Bun/test startup**, not a pure lock-acquisition measurement: baseline 1,835 ms; corrected final after 1,232 ms. Neither value is included in measured trial time. Pure lock wait was not separately instrumented, and is not inferred from these numbers.

### Reproduction

Run from `packages/opencode` in the assigned worktree:

```sh
env SUMMARY_LOCK_REQUEST_MS=$(date +%s%3N) \
  flock /tmp/opencode/perf-batch/bench.lock \
  env SUMMARY_RESULTS=/tmp/opencode/perf-batch/summaries-results/after-freshness.json \
  bun test test/session/summary.bench.test.ts
```

The before command was identical except for `SUMMARY_RESULTS=.../before.json`, with baseline runtime source still present. To repeat the comparison independently, use these same fixture/benchmark files with the specified baseline runtime tree, then with this runtime change. Later fixture edits only fixed TypeScript typing/formatting and changed a serial loop to serial `Effect.forEach`; seeded JSON, volumes, scheduling, gate duration, and counted work are unchanged.

## Correctness and verification

New regression coverage includes:

- Latest burst completion, one user write, and freshly edited retained title/body fields.
- Identical-pair recomputation for requests arriving during or after diff computation.
- Error propagation to joined callers and successful retry afterward.
- Single-waiter cancellation, last-waiter cancellation, and instance disposal/reinitialization.
- Directory isolation and independent user turns within one session.
- Part deletion during snapshot work, user deletion without resurrection, disabled snapshots, absent/non-user targets, and missing-session errors.
- Targeted selection matching full-history selection with retained/compaction assistants and unrelated newer turns.
- **Actual Snapshot integration:** real temporary Git repository, tracked before/after trees, expected file/patch/addition/deletion result, and an identical-tree-pair refresh after changing `.git/info/exclude`.

Executed from `packages/opencode`:

```sh
bun test test/session/summary.test.ts \
  test/session/snapshot-tool-race.test.ts \
  test/session/revert-compact.test.ts \
  test/session/processor-effect.test.ts
# 39 passed, 0 failed, 177 assertions (at that revision).

bun test test/session/summary.test.ts
# After adding revision-aware reuse: 14 passed, 0 failed, 43 assertions.

bun test test/session/summary.test.ts --test-name-pattern "keeps different user turns independent"
# Final added test: 1 passed, 14 filtered out, 0 failed, 5 assertions.

bun typecheck
# Passed after runtime and fixture typing fixes.
```

### Parent freshness review correction

The parent identified that capturing the revision after `diffFull` returned could incorrectly cover a newer request made after mutable ignore rules had already been observed. A new gated regression captures the old ignore-dependent output, changes the ignore state and admits a same-pair second request, then allows the first computation to return. It **failed before the correction**, publishing the old nonempty diff instead of the latest empty diff. Capturing the revision at computation start fixes that race. The previous same-pair test was corrected to expect recomputation for mid-computation requests (two calls for the joined refresh, three after a subsequent independent refresh).

After that focused correction:

```sh
bun test test/session/summary.test.ts
# 16 passed, 0 failed, 52 assertions; includes the actual Git Snapshot smoke.
```

The corrected benchmark also passed its four latest-summary assertions, using the command above and the original benchmark storage. Existing typecheck and broader integration-test passes listed above predate this final correction; parent owns combined verification and deployment.

### Isolated-candidate lifecycle correction

Follow-up diagnosis used the exclusively assigned `/tmp/opencode/perf-batch/commit-check`, restored to full candidate `cb9ed2716478f4c36fcd1ec626097369ba1a2c6d`. It does not depend on main's concurrent user-owned `sessionDiff`/aggregate-summary work.

**Root cause:** Effect `4.0.0-beta.83` directly resumes `Fiber.join` with the worker's interrupted failure. That invokes the join's asynchronous cancellation finalizer, removing its own observer while the worker is iterating its completion observers. The next observer can then be skipped. When worker interruption requires asynchronous resource cleanup, `forkIn`'s scope-close waiter is already registered and can be the skipped observer, leaving instance/layer teardown waiting forever. The earlier synchronous-gate disposal test missed this because the worker could finish before scope teardown registered its waiter.

The minimal runtime correction awaits `Fiber.await(worker)` (an `Exit` delivered as a successful value), then propagates that Exit with `Effect.flatMap`. This preserves the worker scope, coalescing, reference counting, failure propagation, and last-caller interruption, while avoiding removal of a completion observer during interrupted-worker notification. No Effect dependency or timeout setting was changed.

**Failing-before / passing-after evidence:**

- Unmodified full candidate: `bun test test/session/snapshot-tool-race.test.ts --rerun-each 10 --timeout 30000` produced **9 pass, 1 timeout, 40 assertions**. The failing iteration completed all four assertions before hanging in cleanup.
- New deterministic regression: two summary callers share a blocked Snapshot operation; its cancellation finalizer is held at a latch while instance disposal starts, then released. Before the runtime fix, it failed with `summary callers did not settle after worker cleanup`. After the fix, both callers report interruption and instance disposal completes, with no user-message write. Latches control the interleaving; the existing test helper's timeout only bounds deadlock detection.
- After the fix, `bun test test/session/summary.test.ts`: **17 pass, 0 fail, 54 assertions**.
- After the fix, the unchanged snapshot-race command above: **10 pass, 0 fail, 40 assertions**, 20.23 seconds total, with all temporary diagnostic logging removed.

The short benchmark was rerun from the same scratch package, serialized with the existing benchmark lock and writing `/tmp/opencode/perf-batch/summaries-results/after-lifecycle.json`. One warmup and three measured trials yielded **78.123 ms median** (72.791–85.536 ms range). Counts are unchanged: **264 SQL statements, 138 SELECTs, 126 SQL writes, 10 diff calls, 1 user-message update, 9 session-diff events**. All four latest-summary assertions passed. Reported lock-plus-startup time was 1,213 ms, excluded from trial timing. These timings are observations, not evidence that the lifecycle fix itself improves throughput; the controlled fixture now has a default no-op cleanup hook for the regression.

Only the lifecycle fix hunks are carried into integration and main: `src/session/summary.ts`, `test/session/summary-fixture.ts`, `test/session/summary.test.ts` under `packages/opencode`, and this report. Main's user-owned session-wide summary changes are preserved. Parent owns the staged candidate, combined checks, rebuild, deployment, and commit.

The benchmark ran concurrently with the snapshot-race repetitions, so possible resource contention also limits wall-time comparisons.

## Limitations and residual risks

- Timings measure summary orchestration, real database/event work, and a controlled snapshot wait. The boundary returns a small synthetic patch; these numbers do not benchmark Git or growing patch construction. Actual Git behavior has smoke coverage, not a claimed throughput measurement. Snapshot sizing/scanning remains owned by the adjacent assignments.
- No returned-row/byte counter or heap/RSS measurement was added; SQL statement counts, diff calls, event writes, and wall time are the measured metrics. The retained pair cache is bounded to one result per active turn and released when the refresh ends.
- Without a parent-ID expression index, SQLite still evaluates session message JSON to identify direct children, and inspects relevant-turn part JSON. The improvement avoids full transcript/part hydration; it does not make all database work constant in session length. No index addition was made.
- Summaries are advisory/coalesced: intermediate cumulative results and duplicate reset/update events are intentionally suppressed. An already failed shared refresh fails its current waiters; a subsequent summarize call retries. This adds no durable execution or recovery orchestration.
- Endpoint/user revalidation addresses changes during snapshot computation. It is not a new transactional compare-and-swap protocol against arbitrary edits occurring between the final read and event publication; that pre-existing event/update boundary remains.

## Changed paths / integration handoff

- `packages/opencode/src/session/summary.ts`
- `packages/opencode/test/session/summary-fixture.ts`
- `packages/opencode/test/session/summary.bench.test.ts`
- `packages/opencode/test/session/summary.test.ts`
- `specs/perf-summaries.md`

All changes are uncommitted. Runtime integration touches only summary internals and adds its existing Database layer dependency explicitly. There is no file overlap with the processor completed-snapshot/patch-reuse work or Snapshot diff-sizing/scanning work. The authorized five-path integration is prepared with `/tmp/opencode/perf-prepare-integration.py`, producing `/tmp/opencode/perf-batch/summaries-integration.patch`, and applied with `apply_patch`. Parent owns combined checks; retain the raw result files above.

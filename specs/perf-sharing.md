# Sharing listener lifecycle and eligibility

## Scope and baseline

- Assignment: `sharing` (table item 1).
- Worktree: `/tmp/opencode/perf-batch/sharing`.
- Shared baseline tree: `e6f0f15a59125fb1775dd081da144ec16c4622aa` (the worktree index, not HEAD).
- Runtime: Bun 1.4.2, Linux x64.
- Baseline measurement completed before editing runtime code. The same fixture/workload was rerun after the fix. Subsequent benchmark-file edits only format code and narrow the opt-in output environment variable.
- Raw samples: [before](perf-sharing-before.json), [after](perf-sharing-after.json).

## Confirmed mechanism and fix

`ShareNext` installed five callbacks in each `InstanceState` initializer. `EventV2.listen` retains callbacks until its returned unsubscribe effect executes; ShareNext discarded those effects. Disposing state closed its queue scope/maps but left the callbacks alive. Reinitializing the same directory therefore added another five callbacks. Because EventV2 awaits listeners, the extra work also delayed publication.

The callbacks copied session/message/part/diff payloads before `sync` checked the share cache. User-message callbacks resolved models even when the message was not shared. A separate race test confirmed that an in-flight model lookup survived instance disposal.

The fix is confined to `src/share/share-next.ts`:

1. Acquire each listener with `Effect.acquireRelease`, registering its unsubscribe effect in the instance scope. Acquiring the listener and its cleanup is interruption-safe.
2. Run matching callbacks in the existing instance-owned queue scope, still awaiting their completion. Disposal cancels callbacks already awaiting work, preventing them from recreating state or repopulating a queue. Interrupting a publisher also interrupts its callback fiber. Expected disposal interruption is not logged as a subscriber error.
3. Make `sync` take a lazy data factory, evaluated only after eligibility succeeds. Its boolean result gates user model resolution. The subsequent model sync still rechecks eligibility, so removing a share while model resolution is pending cannot enqueue the model.
4. Preserve the one-second asynchronous flush, queue key coalescing, owned structured-clone snapshots for watched shared payloads, full-sync behavior and queue teardown.

## Probe methodology

`test/share/sharing.bench.test.ts` exercises the actual ShareNext, EventV2Bridge, EventV2, Provider, Session, session projector and database services. The fixture decorates instance-local bridge subscriptions and provider lookups to count work; it delegates to the actual implementations. HTTP is an isolated Effect HttpClient recording requests and returning fixture responses. The normal test preload isolates config, home and database paths. No real share endpoint is contacted.

Two sessions are created before listener initialization, one with a seeded share row and one unshared. Each batch publishes:

- one user-message update using the real `openai/gpt-4o` model catalog;
- one completed tool part with a 262,144-byte ASCII output;
- one diff with a 262,144-byte ASCII patch.

Warmup publishes one batch per mode before measurement and one batch before each checkpoint/mode. Measurements run at 0, 5 and 20 disposal/reinitialization cycles. Disposal invokes the same instance registry used by InstanceStore, while the service layers and EventV2 remain alive. Each checkpoint/mode has **five trials of 12 batches = 36 publications**, for 30 trials / 1,080 measured publications per implementation. Durable message/part publication includes real encoding, projection and persistence; the benchmark is not a listener-only microbenchmark.

Counts:

- `retained` = successful listener registrations minus completed unsubscribe effects. This is a deterministic retained-callback proxy, not a heap-byte estimate.
- `callbacks` = actual invocations of the installed ShareNext callbacks, including event-type filtering.
- `clones` = enumerable payload getter visits while ShareNext callbacks execute. Projector/encoding reads outside those callbacks are excluded. Publications are sequential; no global clone replacement is used.
- `clonePayloadBytes` = known large output/patch bytes visited by those clones. It excludes small object fields and does not claim to measure VM allocation or RSS.
- `models` = actual Provider.getModel calls initiated by ShareNext.

Retained heap/RSS were not measured: retained listener counts directly establish this leak, while the real database's growing event history, catalog initialization and temporary clones would confound a small heap delta. Timing includes the actual service instrumentation and any scheduled flush that becomes runnable. Setup, reloads and lock wait are outside measured trial intervals.

## Results

All work counts below are per 36-publication trial and were identical across the five trials in each group.

| Reloads | Mode | Retained listeners before → after | Callback calls before → after | Clones before → after | Large clone payload MiB before → after | Model lookups before → after |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | Unshared | 5 → 5 | 180 → 180 | 36 → 0 | 6 → 0 | 12 → 0 |
| 0 | Shared | 5 → 5 | 180 → 180 | 36 → 36 | 6 → 6 | 12 → 12 |
| 5 | Unshared | 30 → 5 | 1,080 → 180 | 216 → 0 | 36 → 0 | 72 → 0 |
| 5 | Shared | 30 → 5 | 1,080 → 180 | 216 → 36 | 36 → 6 | 72 → 12 |
| 20 | Unshared | 105 → 5 | 3,780 → 180 | 756 → 0 | 126 → 0 | 252 → 0 |
| 20 | Shared | 105 → 5 | 3,780 → 180 | 756 → 36 | 126 → 6 | 252 → 12 |

Both runs registered 105 listeners in total. **After final disposal: 105 retained before, 0 after.**

| Reloads | Mode | Before median ms (min–max) | After median ms (min–max) |
| --- | --- | --- | --- |
| 0 | Unshared | 55.36 (45.43–256.33) | 237.99 (58.11–403.39) |
| 0 | Shared | 38.89 (31.39–51.44) | 54.31 (38.70–85.25) |
| 5 | Unshared | 101.05 (67.99–413.98) | 29.23 (23.76–33.45) |
| 5 | Shared | 67.76 (60.28–114.99) | 38.37 (26.88–46.00) |
| 20 | Unshared | 121.76 (96.33–170.97) | 25.92 (22.35–29.14) |
| 20 | Shared | 129.41 (115.29–134.69) | 32.27 (23.61–56.90) |

At 20 reloads the measured medians improve **4.70× unshared / 4.01× shared**, with a 21× reduction in callback fan-out. **The initial checkpoint regresses in these timing samples** despite eliminating unshared copy/model work. These are single-process runs with substantial early variance; warmup does not guarantee a steady JIT/GC state. Scoped callback fibers also introduce real overhead. The data supports bounded listener retention and the deterministic work reductions; it does not establish an initial-session latency improvement or isolate the cause of the early timing regression.

Successful measurement lock waits were **15,592.97 ms before** and **2.96 ms after**, excluded from the table. An earlier lock attempt timed out without measuring; an initial fixture attempt failed on missing event envelope fields before producing samples. Those attempts are not represented as successful baseline measurements.

## Reproduction

Run from `/tmp/opencode/perf-batch/sharing/packages/opencode` (never the repository root):

```bash
requested=$EPOCHREALTIME
flock /tmp/opencode/perf-batch/bench.lock bash -c '
  acquired=$EPOCHREALTIME
  bun -e "console.log({lockWaitMs: (Number(process.argv[2])-Number(process.argv[1]))*1000})" "$1" "$acquired"
  SHARING_BENCH=/tmp/opencode/perf-batch/sharing/specs/perf-sharing-after.json bun test test/share/sharing.bench.test.ts
' _ "$requested"
```

The baseline command used the same invocation with `perf-sharing-before.json`, before editing ShareNext. Keep the same fixture and baseline tree when reproducing a baseline; the worktree HEAD is not that baseline. Benchmark execution is opt-in via `SHARING_BENCH`; normal test runs skip it.

```bash
bun test test/share/sharing-lifecycle.test.ts test/share/share-next.test.ts
bunx --no-install prettier --check --cache-location /tmp/opencode/perf-batch/sharing/.prettier-cache src/share/share-next.ts test/share/sharing-fixture.ts test/share/sharing-lifecycle.test.ts test/share/sharing.bench.test.ts
git diff --check
```

## Correctness and verification

New regression coverage checks:

- exactly five live listeners despite repeated init, zero after disposal, and no callbacks/state resurrection from later publications;
- no session/message/part/diff copying or model resolution for unshared events;
- cached unshared → create transition and directory isolation;
- shared snapshots remain owned after callers mutate originals, latest-part coalescing and user model updates;
- disposal during a blocked model lookup cancels that callback and the pending flush; reinitialized state flushes only new work;
- remove during a blocked model lookup suppresses the late model sync.

Final verification passed **13 tests / 73 assertions** in 10.90 seconds: six new regressions and seven existing ShareNext tests. Both before/after benchmark runs passed. Prettier checks on all four TypeScript files and `git diff --check` also passed.

An intermediate verification attempt was blocked before test startup by `/tmp` inode exhaustion (`1,048,576 / 1,048,576` inodes used). Verification succeeded after inodes became available; no unrelated files were removed to work around it. The explicit Prettier cache location avoids creating its default cache directory.

Broad typechecking and final integrated build/deployment are owned by the parent assignment. No commits or installs were performed.

## Changed paths and integration notes

- `packages/opencode/src/share/share-next.ts`
- `packages/opencode/test/share/sharing-fixture.ts`
- `packages/opencode/test/share/sharing-lifecycle.test.ts`
- `packages/opencode/test/share/sharing.bench.test.ts`
- `specs/perf-sharing-before.json`
- `specs/perf-sharing-after.json`
- `specs/perf-sharing.md`

No public Protocol/HttpApi changes or generated-client updates. No edits to core EventV2, InstanceState, the shared test preload or existing sharing tests. No expected path overlaps with adjacent snapshot/LSP assignments.

Residual scope: eligibility still uses the existing per-instance share cache and retains its existing concurrent create/remove semantics. Durable EventV2 publication, database serialization and actual required shared payload clones remain real costs. The benchmark isolates two sessions in one directory and is not a production latency forecast.

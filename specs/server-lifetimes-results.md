# Server lifetimes: opt-in leased native search retirement

## Status

Implemented a deliberately narrow, explicit-opt-in lifetime for native search
resources. The 174-test lifecycle/session regression suite and final core typecheck
pass. All 24 paired daemon runs and both disabled-policy controls completed successfully.
Native-resource retirement is supported; returning PSS to startup is not. Keep the
flag disabled by default; the default direct backend has no reliable memory win.

## Hypothesis and acceptance criteria

Retain heavyweight project services only while needed; after controlled project
churn, live resources and process PSS should approach startup baseline. Countermetrics
are cold/revisit latency, warm search latency, cleanup latency, and active-work
correctness. Eviction must preserve provider drains, descendant and independent
jobs, PTYs, pending permissions/questions, detached clients, and late admissions.
At least three independent paired measurements on both HTTP cores are required
before claiming an improvement.

## Provenance and workload

- Worktree `/home/shawn/code/opencode-server-lifetimes`, branch `server-lifetimes`.
- Immutable baseline `8998bdb660d66c31a6e390c1195867b6c303c781`.
- Baseline retention checkpoint `c757cd4e281729e812c92ae832cb191772ad84db`.
- Post implementation/tests/harness commit `81bfb5bd93bde8c58cf38ddf66ef52a42da5f933`.
- Native binary `/tmp/opencode/shared-server-base-bin/opencode`.
- Version `0.0.0-shared-server-202609301000`.
- SHA-256 `9a789076b6e7dda31664a058604a2aa2b8c26f629ce533e8f2d2ddae79e3a2ee` verified before execution.
- Eight isolated small git projects, 100 TypeScript files per project; no commits,
  user credentials, model requests, MCP, or LSP processes.
- Private native shared daemon over its Unix socket; legacy `/find/file` and
  V2 `/api/fs/find` endpoints in separate runs.
- Isolated HOME/XDG/config/database, pure mode, models fetch/autoupdate disabled.
- Both opt-in worker (`OPENCODE_EXPERIMENTAL_FFF_WORKER=1`) and default direct
  (`=0`) backends, matched within each pair.
- Real native FFF workers/indexes/watchers, measured through Linux `/proc`.
- Native daemon PSS only, workers included exactly once as threads. No clients or
  helper fleet PSS. No forced GC or heap snapshot.

## Raw baseline: one sample, legacy core only

| Stage                  | PSS KiB | RSS KiB | Threads | FFF worker threads | Open FDs | inotify watches |
| ---------------------- | ------: | ------: | ------: | -----------------: | -------: | --------------: |
| Ready                  |  242665 |  274200 |      16 |                  0 |       14 |               0 |
| Eight projects visited | 1183253 | 1220912 |      67 |                  8 |       58 |              32 |
| After 2.5 s idle       |  728241 |  765900 |      67 |                  8 |       58 |              32 |
| Revisit first project  |  728377 |  766036 |      67 |                  8 |       58 |              32 |

Cold request times (ms): 985.364, 397.620, 371.335, 361.977, 578.410,
514.048, 540.041, 495.136. First request includes lazy route/service boot.
Warm request times (ms): 4.167, 2.409, 3.014, 2.900, 4.389, 2.680,
2.548, 2.352, 2.887, 2.673. Revisit: 3.790 ms.
These are raw observations, not confidence intervals or paired medians.
PSS falls naturally during idle but resources remain live. This historical sample
established retention; use the paired results below for the optimization comparison.

Artifacts:

- `/tmp/opencode/lifetimes-results/base-legacy-1.json`
- `/tmp/opencode/lifetimes-results/base-legacy-1.json.daemon.log`

Exact successful command, from this worktree:

```sh
flock /tmp/opencode/shared-server-bench.lock python script/bench-server-lifetimes.py \
  /tmp/opencode/shared-server-base-bin/opencode \
  /tmp/opencode/lifetimes-results/base-legacy-1.json --arm base --core legacy
```

The post arm now sets the implemented `OPENCODE_EXPERIMENTAL_SEARCH_IDLE_MS=1000`.
Unset, invalid, zero, negative, unsafe-integer or timer-out-of-range values preserve
the existing search lifetime. Positive safe integers through 2,147,483,647 opt in.

## Ownership decision and implementation

`core/src/location-services.ts` uses Effect LayerMap with 60-minute idle TTL.
The inspected Effect v4 `LayerMap.make` delegates to `RcMap.get`, which acquires
a scoped reference. `SessionExecutionLocal` provides `locations.get(...)` around
the complete runner drain: existing V2 provider execution is already pinned.
That does not pin a detached PTY created by a short request. The PTY layer's
finalizer kills running PTYs. Legacy BackgroundJob is InstanceState-scoped and
can outlive its admission request. Legacy InstanceState uses infinite-capacity,
infinite-TTL ScopedCache, and InstanceStore disposal is separate from requests.
Blindly shortening either graph lifetime is unsafe.

Both HTTP cores delegate filesystem searching to `core/src/filesystem/search.ts`.
A per-search-service admission gate serializes retirement/reopening. Each native
picker and lazy ripgrep fallback has its own child Scope. `find`, `glob`, and `grep`
hold scoped leases through native execution and result materialization. Only the
last lease starts the idle timer. New admission cancels that timer. Timer identity
and entry identity fence obsolete callbacks. Destruction is uninterruptible under
the gate; admission cannot overlap teardown. Owner shutdown closes admission and
waits for outstanding leases before finalizing the last entry. Teardown failure
closes admission rather than creating a potentially overlapping native index.

The installed Effect v4 beta.83 runtime was checked directly: context capture also
captures Scope, so the child Scope must override it _inside_ context provision.
Lease acquisition registers its release while still holding the admission gate.
Whole Location services and existing V2 runner placement are unchanged.

Integration touchpoint for this candidate: `packages/core/src/filesystem/search.ts`
and a dedicated experimental flag. No public API/SDK generation should be needed.
Full graph lifetime reclamation remains blocked on a coherent ownership design.

## Verification and cleanup

- Offline frozen worktree-only dependency installation succeeded under the lock.
- Bun resolution verified `@opencode-ai/core/filesystem/search` resolves into this
  worktree, not another branch.
- Baseline native daemon benchmark exited successfully under the lock.
- Harness terminates/waits for its private daemon and removes its fixture tree
  in `finally`; the successful run completed that cleanup.
- Native build succeeded: `0.0.0-server-lifetimes-202609301025`, SHA-256
  `527cd6fb4781ef56301436b09519bd1b2827dd0f8b4191521c183d2a8208fc7b`.
  Build artifact remains worktree-local as required by the experiment rules.
- 174 tests across 9 files passed, 1,307 assertions, 10.10 seconds. Coverage includes
  real direct/worker search, held concurrent queries past idle, owner close after
  reopen, cancelled admission during destruction, exact-once disposal, held native
  initialization with late picker cleanup, and held grep results (>128 matches).
- The integration test keeps a real SessionRunCoordinator drain suspended, starts
  a descendant job from inside its parent job, detaches/reattaches a native PTY,
  and holds actual permission/question requests. All survive native search retirement,
  then complete; search reopens successfully. The held drain substitutes deterministic
  waiting for provider I/O; it is not a live-provider/fleet benchmark.
- Existing session runner, coordinator, job, PTY, permission and question regressions
  also passed. Typechecking initially identified test-only picker annotations that
  omitted concrete backend diagnostics; these were corrected without runtime changes.
  Final `bun typecheck` from `packages/core` completed with exit 0.
- The paired harness and both disabled-policy controls completed with exit 0.
  Final cleanup checks found no remaining `lifetimes-*/daemon/server.json` fixtures
  or worktree-built native daemon processes.
- No installed binaries, main/global source, other worktrees, or job registries modified.

## Exact reproduction

From `packages/core`:

```sh
flock /tmp/opencode/shared-server-bench.lock bash -lc 'bun test test/filesystem/search.test.ts test/filesystem/search-lifetime.test.ts test/filesystem/fff-worker.test.ts test/background-job.test.ts test/pty/pty-session.test.ts test/question.test.ts test/permission.test.ts test/session-run-coordinator.test.ts test/session-runner.test.ts && bun typecheck'
```

From `packages/opencode`:

```sh
flock /tmp/opencode/shared-server-bench.lock bun run script/build.ts --single --skip-install --skip-embed-web-ui
```

From this worktree root:

```sh
flock /tmp/opencode/shared-server-bench.lock python script/bench-server-lifetimes-paired.py /tmp/opencode/shared-server-base-bin/opencode packages/opencode/dist/opencode-linux-x64/bin/opencode /tmp/opencode/lifetimes-results/paired
```

Disabled-policy controls, from this worktree root:

```sh
flock /tmp/opencode/shared-server-bench.lock bash -lc 'for backend in worker direct; do python script/bench-server-lifetimes.py packages/opencode/dist/opencode-linux-x64/bin/opencode /tmp/opencode/lifetimes-results/post-disabled-$backend-legacy.json --arm base --core legacy --backend "$backend" || exit; done'
```

Three independent pairs per backend/core, alternating base/post, post/base,
base/post (24 fresh daemons total). `--reuse` resumes completed samples only after
validating binary hash, arm, core and backend. Raw artifacts and SHA-256 manifest
are under `/tmp/opencode/lifetimes-results/paired/`; `summary.json` contains all
stage PSS/RSS/FD/thread/watch medians, CPU deltas and observed ranges. Historical first
six samples were reused after correcting a mistaken harness criterion that
required _all_ project watches to disappear. The corrected criterion requires
all native worker/watcher threads to disappear, preserving unrelated watches.
An added untimed inode diagnostic identifies retained watches after final sampling.

CPU windows: churn CPU is ready→churn; idle CPU is churn→idle and includes the
10 warm requests and identical 100ms observation schedule; revisit CPU includes
rescan and new-file visibility verification. Cold and revisit first calls are
distinct from waiting until nonempty results. No client/helper process PSS or
CPU is counted. This is a native-daemon search workload, not full-fleet savings.

## Paired results and recommendation

All values are measured native-daemon-only observations. Memory is MiB (KiB/1024),
latency and process CPU are ms. Brackets are observed min–max, not confidence intervals.
Memory/resource medians use three independent daemons per arm; later-project cold
latency pools 21 calls and warm latency pools 30 calls per backend/core/arm.

### PSS

| Backend/core    | Ready median base → post | Churn median base → post | Idle base median [range] | Idle post median [range] | Second idle median base → post |
| --------------- | -----------------------: | -----------------------: | -----------------------: | -----------------------: | -----------------------------: |
| Worker / legacy |          266.62 → 269.01 |         1200.09 → 908.03 |   706.55 [680.84–846.51] |   646.66 [594.00–655.91] |                707.15 → 646.27 |
| Worker / V2     |          267.26 → 267.48 |          682.87 → 646.57 |   598.61 [584.54–608.00] |   547.22 [545.97–550.01] |                590.02 → 547.55 |
| Direct / legacy |          265.85 → 269.22 |          953.14 → 843.86 |   763.72 [613.40–851.60] |   731.96 [670.20–876.86] |                624.98 → 628.96 |
| Direct / V2     |          268.02 → 268.30 |          663.87 → 696.52 |   582.12 [510.64–583.78] |   584.90 [569.45–586.98] |                558.82 → 560.46 |

Paired idle PSS deltas (post minus corresponding base), in repeat order:

- Worker / legacy: −59.88, −190.61, −86.84 MiB.
- Worker / V2: −34.53, −52.64, −60.78 MiB.
- Direct / legacy: +118.56, −181.41, +113.14 MiB.
- Direct / V2: +74.25, −12.67, +3.21 MiB.

Worker idle medians fall about 8.5% on both cores and all three pairs improve,
but process PSS remains roughly twice startup. Direct idle results are mixed;
the apparent legacy median reduction is not a consistent paired improvement and
disappears at the second idle measurement. These measurements do not establish
a default-direct memory benefit. RSS is secondary: idle medians base → post are
713.54 → 653.65 (worker legacy), 604.91 → 553.52 (worker V2), 770.71 → 738.95
(direct legacy), and 588.39 → 591.20 (direct V2) MiB.

### Live resources and cleanup

| Backend/core    | Idle threads base → post [ranges] | Idle FDs base → post | Native workers base → post | Native watcher threads base → post | Inotify watches base → post | Post cleanup ms median [range] |
| --------------- | --------------------------------: | -------------------: | -------------------------: | ---------------------------------: | --------------------------: | -----------------------------: |
| Worker / legacy |           67 [67–68] → 37 [36–37] |              58 → 18 |                      8 → 0 |                             24 → 0 |                      32 → 8 |      1061.69 [1060.04–1107.99] |
| Worker / V2     |           66 [66–67] → 35 [35–37] |              57 → 17 |                      8 → 0 |                             24 → 0 |                      32 → 8 |      1041.34 [1034.55–1049.35] |
| Direct / legacy |           59 [59–59] → 35 [35–35] |              42 → 18 |                      0 → 0 |                             24 → 0 |                      32 → 8 |      1081.91 [1060.60–1090.04] |
| Direct / V2     |           59 [58–59] → 35 [34–35] |              41 → 17 |                      0 → 0 |                             24 → 0 |                      32 → 8 |      1029.54 [1027.76–1035.22] |

These FD/worker/watcher/watch counts have identical min/max over their three
samples. Cleanup is the first observation without native worker/watcher threads,
measured from the end of the warm burst; 100ms observation cadence limits precision.
The 16 shared `fff-bg-*` pool threads remain after retirement. Untimed inode
diagnostics identify the eight retained watches as `project-{0..7}/.git` in all
new post samples. They belong to retained Location/bootstrap watching, not native
search. Revisit creates the new native index and retires it again; all 24 arms
eventually observe `fresh-after-idle.ts` without API errors or process crashes.

### Latency countermetrics

| Backend/core    | First cold median base → post | Later cold base median [range] | Later cold post median [range] | Warm base median [range] | Warm post median [range] | Revisit base median [range] | Revisit post median [range] | Nonempty revisit-ready median base → post |
| --------------- | ----------------------------: | -----------------------------: | -----------------------------: | -----------------------: | -----------------------: | --------------------------: | --------------------------: | ----------------------------------------: |
| Worker / legacy |              970.85 → 1038.24 |         485.37 [336.39–910.36] |         549.95 [359.78–773.72] |        2.47 [2.04–14.63] |        2.79 [2.00–11.99] |            3.42 [3.37–3.74] |         12.76 [11.66–12.91] |                              3.45 → 38.18 |
| Worker / V2     |               836.59 → 765.73 |         339.58 [293.35–391.87] |         329.16 [294.08–353.64] |         2.59 [1.76–3.64] |        2.67 [1.94–14.89] |            3.27 [3.04–3.75] |         13.05 [11.96–13.53] |                              3.30 → 37.18 |
| Direct / legacy |               958.30 → 959.64 |         435.92 [325.54–700.49] |         452.07 [322.47–609.86] |         2.45 [1.78–4.71] |         2.23 [1.76–7.25] |           3.10 [3.10–13.96] |           2.57 [2.11–21.99] |                              3.14 → 25.48 |
| Direct / V2     |               715.39 → 726.36 |         312.01 [286.12–446.16] |         328.57 [297.12–372.73] |         1.83 [1.62–4.14] |         2.19 [1.81–9.93] |            2.93 [2.86–3.68] |            2.59 [1.97–2.88] |                              2.96 → 25.79 |

First-cold calls include lazy route/service initialization. First revisit responses
can be empty while the asynchronous native scan starts, so their latency alone
understates reopen cost. Post nonempty readiness ranges are 35.60–38.78, 35.37–37.46,
25.11–44.86 and 25.66–27.07 ms, respectively; the harness polls every 20ms, so these
are measured readiness with polling overhead, not exact native scan durations.
No independent event-loop/cancel-latency benchmark or statistically meaningful tail
estimate was made; observed request extrema are recorded rather than hidden.

### Process CPU countermetrics

| Backend/core    | Churn base median [range] | Churn post median [range] | Idle base median [range] | Idle post median [range] | Revisit base median [range] | Revisit post median [range] |
| --------------- | ------------------------: | ------------------------: | -----------------------: | -----------------------: | --------------------------: | --------------------------: |
| Worker / legacy |          7180 [7120–8440] |          7880 [7790–8940] |            710 [710–720] |            410 [170–520] |                  30 [20–50] |                  30 [30–40] |
| Worker / V2     |          4840 [4810–4890] |          4850 [4750–4910] |            130 [110–430] |            120 [120–150] |                  30 [30–30] |                  30 [30–30] |
| Direct / legacy |          6970 [6950–7380] |          6780 [6380–6860] |            410 [110–610] |            550 [530–620] |                  20 [10–40] |                  20 [10–40] |
| Direct / V2     |          4540 [4440–4660] |          4640 [4390–4660] |              90 [90–110] |             100 [90–100] |                  20 [20–30] |                  20 [10–20] |

Process CPU includes worker threads once and has 10ms tick resolution. Idle covers
warm requests/cleanup/normal allocator activity; it is not isolated finalizer CPU.
Worker legacy has higher churn CPU (~9.7% by medians), direct legacy has higher
idle CPU, and warm request extrema sometimes regress. No throughput benefit is claimed.

### Provenance, controls and decision

All 48 raw JSON/log SHA-256 entries in `summary.json` were independently recomputed
and matched. Summary SHA-256:
`d5fe7d3e2b73bb73b59ca5772a4987ed96d4a818bbe87cfe116643a6f6e776e3`.
Baseline/post binary hashes above are fixed for the entire matrix. The post build
contains the final runtime implementation; later changes were explanatory comments,
tests and harness/report refinements.

The new binary with idle policy disabled was checked separately on both native
backends through legacy HTTP. Worker retains eight workers, 24 native watcher
threads, 58 FDs and 32 watches; direct retains 24 native watcher threads, 42 FDs
and 32 watches. Both successfully observe the new file after revisit. These are
controls for unchanged retention, not extra paired performance samples. `--arm base`
leaves the policy unset; the raw `idle_ms: 1000` field records the candidate threshold,
not an enabled policy in these controls or the baseline arm.

Control JSON artifacts and SHA-256:

- `/tmp/opencode/lifetimes-results/post-disabled-worker-legacy.json`:
  `deabaf2f8d914340d1a3a734cecbf8cf091d7f62a7ff3c42aa2b3ad19c3fada4`.
- `/tmp/opencode/lifetimes-results/post-disabled-direct-legacy.json`:
  `641cc31b411ab26ed4230e4069a9518fd298266d2e48633f9c0d379141c2eb44`.

Recommendation: **accept only as an explicit opt-in experiment**, preserving current
defaults. Native resource reclamation is consistent and active-service correctness
is verified. Reject the broad claim that this returns project-churn PSS to startup,
and do not enable a 1000ms policy by default: direct PSS is inconsistent and reopen
readiness worsens on all four combinations. Full Location reclamation needs separate
ownership for detached PTYs/jobs/approvals and realistic provider/client workload
verification; blindly reducing Location TTL remains unsafe. No client-close
cancellation or durable session/job behavior was introduced.

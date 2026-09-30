# PARALLEL experiment — bounded opt-in native executor

The implementation, correctness checks, native CLI build and three alternating
compiled-daemon pairs are complete. **Accept as opt-in**: concurrent daemon
search throughput and responsiveness improve, at increased PSS. The source
mixed-grep mechanism also regresses individual search latency, so these results
do not justify changing the default.

## Provenance and hypothesis

- Worktree `/home/shawn/code/opencode-server-parallel`, branch `server-parallel`.
- Baseline `8998bdb660d66c31a6e390c1195867b6c303c781`.
- Frozen CLI `/tmp/opencode/shared-server-base-bin/opencode`, version
  `0.0.0-shared-server-202609301000`, SHA256
  `9a789076b6e7dda31664a058604a2aa2b8c26f629ce533e8f2d2ddae79e3a2ee`.
- Hypothesis: native synchronous FFF search blocks daemon control traffic;
  bounded shared worker execution improves responsiveness and cancellation.
- Countermetrics: search latency, throughput, process PSS, threads, CPU, startup.
- Bun 1.4.2; AMD Ryzen 9 5950X 16-Core Processor.

## Completed source-level measurements

These are **mechanism measurements, not full-daemon or fleet results**. Real
FFF native indexed Git fixture: 4,000 files, roughly 63 MB, unique Unicode match
lines and representative source content. Eight concurrent callers issue 80
mixed file searches, absent-token greps and 1,000-result greps. Concurrent
setImmediate control probes and deterministic timer gates model control traffic;
they do not execute SessionRunner. No forced GC. An external process samples
whole measured-process PSS; Worker threads are already included, not added again.

Baseline default-vs-existing-worker ran before production edits, with three
paired repeats alternating order. Subsequent candidate comparison ran three
repeats; that early candidate run did not alternate arm order. The final source
suite completed three paired, alternating repeats (D/P, P/D, D/P).

Median across the three per-run statistics:

| Quantity                     | Original direct | Original single worker |
| ---------------------------- | --------------: | ---------------------: |
| Search completion p50, ms    |            4.99 |                  42.04 |
| Search completion p95, ms    |           35.73 |                  51.40 |
| Warm loop lag p95, ms        |          108.49 |                   0.79 |
| Control probe p95, ms        |           28.41 |                  0.044 |
| Throughput, requests/s       |          212.65 |                 178.26 |
| Sampled process PSS p50, KiB |         120,559 |                131,983 |
| CPU over timed workload, ms  |           3,764 |                  3,947 |

Original direct cancellation deadlines could not run before the operation
completed (18/18 completed before abort). Worker cancellation detached 18/18
callers; timer deadlines were generally near 2 ms and settlement sub-ms. Native
synchronous FFI itself is not preempted.

Early production candidate, two indexed handles balanced over two shared
workers, versus unchanged Direct in the same source tree:

| Quantity                     | Direct control | Candidate |
| ---------------------------- | -------------: | --------: |
| Search completion p50, ms    |           5.41 |     30.45 |
| Search completion p95, ms    |          42.02 |     48.67 |
| Warm loop lag p95, ms        |         114.98 |      0.81 |
| Throughput, requests/s       |         184.26 |    230.19 |
| Sampled process PSS p50, KiB |        121,391 |   133,267 |
| Sampled process PSS p95, KiB |        126,887 |   159,067 |
| CPU over timed workload, ms  |          3,843 |     3,788 |

Raw rows preserve cold readiness/first query, lag, gates, all cancellation
outcomes, PSS/thread sample series and individual repeat statistics. Individual
search p50 is materially worse despite responsiveness and throughput gains;
do not suppress that countermetric. No confidence intervals are claimed.

Final alternating suite (median of three per-run values; brackets are observed
minimum–maximum, not confidence intervals):

| Quantity                  |            Direct control |                 Candidate |
| ------------------------- | ------------------------: | ------------------------: |
| Search completion p50, ms |          5.24 [5.24–5.47] |       30.17 [29.63–31.47] |
| Search completion p95, ms |       43.83 [39.82–52.30] |       46.21 [40.99–57.07] |
| Warm loop lag p95, ms     |    113.11 [105.18–121.86] |          0.80 [0.76–1.00] |
| Control probe p95, ms     |       30.14 [29.77–30.79] |          0.11 [0.08–0.13] |
| Throughput, requests/s    |    194.99 [186.51–200.77] |    231.11 [224.65–232.51] |
| Process PSS p50, KiB      | 121,027 [120,311–124,403] | 133,407 [131,247–134,531] |
| Process PSS p95, KiB      | 126,203 [124,611–128,083] | 157,999 [157,123–160,591] |
| CPU over workload, ms     |       3,813 [3,807–3,894] |       3,707 [3,690–3,868] |
| Threads p50               |                68 [68–68] |                75 [75–75] |
| Cold ready, ms            |       66.17 [65.46–68.36] |       71.82 [71.75–72.60] |

Final direct cancellation: 18/18 completed before abort. Candidate: 18/18
callers detached, abort deadlines 2.02–3.59 ms, settlement 0.025–0.363 ms.
This does not preempt native synchronous FFI.

### Raw artifacts

- `/tmp/opencode/server-parallel/mechanism-baseline.json`
- `/tmp/opencode/server-parallel/mechanism-lanes.json` (two-lane design probe)
- `/tmp/opencode/server-parallel/mechanism-post.json` (early candidate)
- `/tmp/opencode/server-parallel/mechanism-final.json` (final alternating suite)
- Fixture `/tmp/opencode/server-parallel/fixture` is regenerated by `prepare`.
- Baseline stdout log:
  `/home/shawn/.local/share/opencode/tool-output/tool_0f1c52a3a001jGa2L9NRCL7N2l.stdout.log`
- Candidate stdout log:
  `/home/shawn/.local/share/opencode/tool-output/tool_0f1c754e00014Hk6VqcRWP0CUA.stdout.log`

## Compiled-daemon paired results

The exact frozen baseline/candidate hashes above/below were used for three fresh
pairs in B/C, C/B, B/C order. Every arm completed all correctness assertions.
These are daemon + helper descendants + one local provider/HTTP-client process
measurements, **not interactive-TUI fleet results**. Native FFF handles file
search; the four real model glob tools use rg. Each arm completes 320 searches,
four two-turn model Sessions and one separate interruption check.

Median of the three per-run statistics; brackets are observed min–max:

| Quantity                                |              Baseline direct |             Candidate opt-in |
| --------------------------------------- | ---------------------------: | ---------------------------: |
| Search completion p50, ms               |          75.62 [74.88–76.91] |          37.91 [37.51–55.98] |
| Search completion p95, ms               |       301.66 [297.85–302.22] |       135.25 [104.73–200.79] |
| Health probe p95, ms                    |       288.09 [269.82–295.16] |       175.93 [171.53–180.44] |
| Control probe p50, ms                   |          71.87 [71.73–72.21] |             0.48 [0.41–0.95] |
| Control probe p95, ms                   |       288.06 [269.78–291.07] |       175.90 [171.50–180.41] |
| Slowest glob-to-next-model, ms          | 2,032.54 [1,960.03–2,267.73] | 1,267.47 [1,245.17–1,739.23] |
| Native search throughput, requests/s    |          70.09 [70.06–72.32] |        114.87 [80.18–114.88] |
| Model interrupt HTTP latency, ms        |             8.16 [3.83–8.98] |           10.18 [3.50–10.65] |
| Daemon PSS p50, KiB                     |    513,966 [502,398–521,166] |    580,026 [562,127–611,206] |
| Sampled fleet PSS p50, KiB              |    575,178 [564,286–582,906] |    642,303 [622,107–670,343] |
| Sampled fleet PSS p95, KiB              |    690,810 [687,594–693,106] |    706,727 [703,363–713,359] |
| Daemon + reaped helpers CPU, ms         |          5,000 [4,820–5,080] |          4,910 [4,890–6,120] |
| Sampled fleet CPU over workload, ms     | 9,232.78 [8,970.68–9,293.58] | 7,687.14 [7,580.99–9,771.05] |
| Sampled fleet threads p50               |                   63 [63–64] |                   70 [69–70] |
| Application startup, ms                 |     638.32 [611.74–1,072.15] |       636.10 [634.09–663.87] |
| Application-cold first native query, ms | 1,064.06 [1,052.74–1,107.16] | 1,059.58 [1,033.77–1,102.00] |

The median throughput gain is 63.9%, control p95 falls 38.9%, and sampled fleet
PSS p50 increases 11.7% (67,125 KiB). One candidate repeat is substantially slower
than the other two; three repeats and these ranges are not confidence intervals.
Candidate control tails still include >1 s maxima during the mixed Session
workload: the native worker boundary does not eliminate all daemon stalls.
Model interruption median regresses; no interruption-speed improvement is claimed.
Fleet CPU includes probe/provider/client overhead. Probes run at the same rate
over different workload durations, so fewer probes and a shorter run contribute
to lower total CPU; this is not isolated native-search CPU savings.

All 36 HTTP aborts per arm detached: baseline deadlines 1.02–1.91 ms, settlement
0.038–0.106 ms; candidate deadlines 1.03–1.85 ms, settlement 0.034–0.463 ms.
Post-cancel control latency ranges are 0.54–17.58 / 0.20–4.67 ms. Because these
deadlines execute in the separate client process, baseline HTTP abort success
does not prove daemon FFI cancellation. Native FFI is not preempted. Real queued
RPC removal and active-owner protection are established by the Core tests.

Each candidate arm produced two `fff-worker` acknowledgements from
`file:///$bunfs/root/opencode-fff-worker.js`. Every arm rejected native fallback,
verified all four durable histories contain real glob output and final model
text, and verified completed/interrupted Sessions disappear from the active map.
All child harnesses and daemon processes exited. A post-run check found all 45
unique sampled PIDs across the six paired arms and smoke absent. Generated
fixture and isolated data/cache/state/daemon directories were removed; raw
JSON, logs, histories and configs were retained.

Raw samples, hashes, provider timelines, cancellation outcomes and native
acknowledgements: `/tmp/opencode/server-parallel/daemon-paired.json`.
Per-arm logs/history: `/tmp/opencode/server-parallel/paired-{0,1,2}-{baseline,candidate}/`.
Run log: `/home/shawn/.local/share/opencode/tool-output/tool_0f1df7794001ihSSK83qfTbOL4`.

## Implementation

- `fff-pool.ts`: process-wide bounded worker executor (default 2, configurable
  `OPENCODE_FFF_WORKERS` 1–8), multiplexed Location-owned native handles.
- `fff.worker.ts`: native picker map keyed by logical owner; per-owner disposal.
- `fff.bun.ts`: candidate two-handle load balancing, direct/no-Worker escape;
  currently explicit `OPENCODE_EXPERIMENTAL_FFF_WORKER=1` enables candidate.
- `fff-client.ts`: bounded 32 admitted + 128 waiting callers per handle, busy
  errors on overflow, remove obsolete shared RPCs before FFI, preserve active
  FFI ownership until response/disposal; debug initialization path diagnostics.
- `fff-types.ts`: transport boundary, owner ID, busy error and normalized config.
- `cli/daemon.ts`: effective normalized search settings participate in identity.
- Disabled settings preserve the original daemon profile identity; enabled
  normalized budgets isolate daemon profiles. Explicit daemon paths still win.
- Tests added for shared ownership, worker failure/replacement, queue cap,
  cancellation before FFI, cross-owner fairness and clone-failure disposal.
- No LocationMap/job registry/SQLite/provider execution edits.

## Verification

Worktree-local offline frozen dependency installation succeeded; workspace
resolution verified Core resolves into this worktree.

- Core `bun typecheck`: passed.
- Filesystem worker/search suites: **52 pass, 0 fail, 522 assertions**.
  Exercises real native search, budgets 1/2/8 and invalid budgets, nine owners,
  cleanup, FIFO fairness, queued cancellation, active FFI ownership, worker
  crash/replacement, clone failure/disposal, bounded admission/overflow, all
  159 admitted/waiting scan calls draining, no-Worker direct-native search,
  unavailable-native import and an actual Node subprocess unavailable contract.
- Daemon profile test: **1 pass, 19 assertions**, including normalized enable
  values/budgets, disabled identity preservation and explicit directory override.
- CLI `bun typecheck`: only known baseline error remains at
  `packages/tui/src/component/dialog-usage-stats.tsx:43`, missing `sdk.globalClient`.
- Native CLI build: passed, smoke version `0.0.0-server-parallel-202609301027`.
  Frozen artifact `/tmp/opencode/server-parallel/candidate-opencode`, SHA256
  `dfddc564d0bce2b0e3bd22e7f5adc630fd424cc3bb1b79d31e4a8aba749c13d3`.
- Compiled candidate daemon smoke: passed. Two native acknowledgements report
  `fff-worker` and `file:///$bunfs/root/opencode-fff-worker.js`; no native fallback.
  Four real glob Sessions completed with durable output and eight model calls;
  a fifth Session interrupted and became idle. All 320 native HTTP searches and
  health/control probes succeeded; 12 HTTP callers detached on abort. This is a
  packaging/correctness smoke, not a paired performance result. Raw evidence:
  `/tmp/opencode/server-parallel/daemon-candidate-smoke.json` and
  `/tmp/opencode/server-parallel/candidate-smoke-0-candidate/server.log`.
- Prettier and `git diff --check`: passed.

The full-daemon harness uses fresh isolated HOME/XDG/config and fixed binary
hashes, four gated local OpenAI-compatible model Sessions with real glob tools,
eight native file-search HTTP clients, health/control probes, interruption and
history/idle assertions, and process PSS/CPU sampling. Real model glob uses rg;
native FFF is exercised by `/api/fs/find`. Threads are counted within process
PSS, never added as separate memory. The measured fleet comprises the daemon,
its helper descendants and one Bun process hosting provider plus HTTP clients;
it does not represent a fleet of interactive TUI terminals.
Each repeat sends 320 native file searches (eight clients × 40 turns), releasing
all four model calls together. File search and real model glob are distinct
workloads; this daemon test does not exercise native grep. Warm PSS samples cover
the gated workload through cancellation and idle completion. CPU includes daemon
threads, reaped helper CPU and the provider/client process; the coordinator is
excluded. Startup/cold-query values are application-cold with fresh HOME/XDG,
not an OS page-cache eviction experiment. Tool timing ends when the next provider
turn arrives after the actual glob; it is not the full Session completion time.

Early harness smoke attempts failed on ArrayBuffer hashing, endpoint detection,
loading legacy provider configuration into the current Location catalog, and
calling the baseline's unavailable `session.wait` endpoint. These are validation
failures, not performance samples. The native V2 catalog now runs real models;
the harness observes idle completion via the real `/api/session/active` map.
The compiled candidate smoke and all six paired daemon arms pass the workload
assertions. Failed smoke attempts are excluded from both performance tables.

Reproduction commands (all heavy commands require the lock):

```bash
# from packages/core
flock /tmp/opencode/shared-server-bench.lock bun bench/server-parallel.ts prepare
flock /tmp/opencode/shared-server-bench.lock env OPENCODE_EXPERIMENTAL_FFF_WORKER=1 PARALLEL_ARMS=direct,parallel PARALLEL_LABEL=final bun bench/server-parallel.ts suite
flock /tmp/opencode/shared-server-bench.lock bun typecheck
flock /tmp/opencode/shared-server-bench.lock bun test test/filesystem/fff-worker.test.ts test/filesystem/search.test.ts
# from packages/opencode
flock /tmp/opencode/shared-server-bench.lock bun test test/cli/daemon-search-profile.test.ts
flock /tmp/opencode/shared-server-bench.lock bun run script/build.ts --single --skip-install --skip-embed-web-ui
flock /tmp/opencode/shared-server-bench.lock env PARALLEL_ARMS=baseline,candidate bun script/server-parallel.ts fresh-label /tmp/opencode/server-parallel/candidate-opencode
```

No global install or main/integration worktree edits. Raw JSON, logs, histories,
isolated configs and frozen binaries remain available; the generated fixture and
isolated runtime data/cache/state are cleaned after measurement. Use a fresh
label for reproduction and regenerate the fixture first. Recommendation:
**accept as opt-in**, with the source mixed-grep latency and daemon memory costs
preserved as countermetrics. The responsiveness/throughput hypothesis is
supported for this bounded concurrent workload, not for every search workload.

Integration touchpoints: PARALLEL owns the native pool/client/worker boundary
and daemon search-profile identity. LIFETIMES must preserve `destroy()`'s
acknowledgement and active ownership when releasing Location search resources.
MINI/JOBS remain separate. No public Protocol changes or generated SDK edits.

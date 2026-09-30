# JOBS — coalesced updates and opt-in terminal payload release

**Recommend default coalesced dirty notifications, synchronized in-place registry
updates and foreground write backpressure. Keep terminal payload release opt-in.**
Three alternating baseline/default/opt-in service samples, Core checks, 33 shell/task
tests and native build pass. The production checkout and global installation are
untouched. Full package typecheck still needs the separately verified baseline
`/usage` fix from integration.

## Hypothesis and implementation

Coalesced dirty notifications replace perpetual 200 ms polling with a sliding
one-token queue and retain the existing update throttle/delivery retry. Registry
mutations remain serialized by SynchronizedRef but stop copying the whole Map.
Foreground disk writes await callbacks and completion drains the output consumer
inside the abort/timeout race, including when descendants retain an output pipe.

`OPENCODE_EXPERIMENTAL_JOB_OUTPUT_RELEASE=1` additionally releases terminal active
registry structures after final projection and completion callbacks acknowledge
delivery. It persists the bounded 30,000-character tail beside existing logs and
keeps lightweight owner-lifetime descriptors. Get/list/wait reload tails with
bounded eight-way list hydration. This flag is false by default.

**Limitations:** descriptor indexes still grow with history; this does not establish bounded total daemon RAM. Durable tails are not a restart-recovery design. Full-list hydration adds filesystem work. No automatic release occurs without an onUpdate consumer. No global instance eviction was added.

## Provenance / reproduction

Baseline: `8998bdb660d66c31a6e390c1195867b6c303c781`. The frozen CLI supplied by the parent is version `0.0.0-shared-server-202609301000`, SHA256 `9a789076b6e7dda31664a058604a2aa2b8c26f629ce533e8f2d2ddae79e3a2ee`; these are **service-source** measurements, not that binary or fleet measurements. `script/jobs-baseline.ts` loads the four actual production sources from the immutable commit using Bun's loader; it does not reimplement their behavior. All arms use the same Bun 1.4.2 dependency tree/harness, isolated HOME/XDG/database and real subprocess workload. Samples record source/harness SHA256s. No forced GC or heap snapshots during measurement.

From `packages/opencode`, under the lock:

```
flock /tmp/opencode/shared-server-bench.lock env JOBS_ARM=baseline bun --preload ./script/jobs-baseline.ts ./script/bench-server-jobs.ts
flock /tmp/opencode/shared-server-bench.lock bun script/bench-server-jobs.ts
flock /tmp/opencode/shared-server-bench.lock bun test test/tool/background-shell.test.ts test/tool/task.test.ts
flock /tmp/opencode/shared-server-bench.lock bun typecheck
flock /tmp/opencode/shared-server-bench.lock env JOBS_RESULTS=/tmp/opencode/server-jobs-new bun script/run-server-jobs.ts
bun script/summarize-server-jobs.ts /tmp/opencode/server-jobs-new/samples.json
```

Workload: 200 short bounded-output real shell jobs, 40 quiet stdin jobs observed for 3 seconds, then 100 output bursts, EOF, log search, and cancellation. Clock instrumentation counts real 200ms sleeps/wakes. PSS is the service-host process, not an additive fleet total; idle child helpers are not included.

## Final paired results

Three independent samples per arm, alternating baseline→default→opt-in,
opt-in→default→baseline, baseline→default→opt-in. Values are medians [min,max],
not confidence intervals. Every sample returns 6,000,000 tail characters,
200 completion callbacks and the expected searchable log line.

| Metric                      |                  Baseline |                   Default |            Release opt-in |
| --------------------------- | ------------------------: | ------------------------: | ------------------------: |
| Short jobs elapsed ms       |    766.99 [746.14,863.24] |    814.53 [776.88,865.46] |    772.26 [758.26,805.37] |
| Registry list ms            |       0.605 [0.519,0.635] |       0.652 [0.540,0.815] |       7.518 [6.482,9.176] |
| Shell list ms               |       0.306 [0.287,0.343] |       0.855 [0.661,0.899] |       7.941 [7.427,7.946] |
| Idle polling wakes          |             600 [600,600] |                   0 [0,0] |                   0 [0,0] |
| Idle host CPU us            |    48,590 [45,233,51,833] |    18,754 [18,702,23,185] |    23,067 [19,469,23,069] |
| Host voluntary-switch proxy |             104 [101,129] |                29 [22,30] |                25 [23,35] |
| Retained host PSS KiB       | 293,123 [245,556,294,652] | 284,467 [284,263,294,079] | 251,651 [248,260,256,371] |
| Burst ms                    |      9.998 [8.934,10.671] |    10.591 [10.155,11.263] |    10.687 [10.351,10.847] |
| Cancel ms                   |    20.388 [19.369,21.554] |    19.350 [18.338,19.890] |    21.386 [19.197,25.291] |

Default removes all measured polling wakeups and lowers idle host CPU by 61.4%.
It does not demonstrate a short-job throughput win: its elapsed median is 6.2%
higher with overlapping ranges. Full-shell-list overhead rises by 0.55 ms.
Default PSS ranges overlap; no default RAM reduction is established.

Opt-in retained PSS is 14.1% lower than baseline by final medians, but baseline
ranges overlap and an earlier valid pilot showed no clear memory benefit.
Against final default it is 11.5% lower, with non-overlapping observed ranges.
These small samples expose allocation/GC variance; they are not evidence of
bounded daemon memory. Full-list disk hydration costs about 7–8 ms versus
sub-millisecond baseline/default, and cancellation median rises 4.9% versus
baseline. Keep release disabled unless that workload-specific tradeoff is wanted.

Final raw artifacts: `/tmp/opencode/server-jobs-parent-final/samples.json` and
per-repeat JSON/log files. Every JSON has immutable baseline, Bun version,
production source hashes and common timed-harness hash
`4091eb3eb5051cd21544d052e6fc4da0d9587b8bd7e33f2059bc4b044625b6cf`.
Final runner log: `tool_0f1deaf38001RyidYM8PDyx9GO`.
Earlier valid pilot: `/tmp/opencode/server-jobs-parent-pairs/samples.json`;
not pooled with final samples. Foreground review changed a source hash afterward.

## Historical invalid probes (excluded from final results)

| Metric                   | Baseline valid sample | First post sample, workload failed |
| ------------------------ | --------------------: | ---------------------------------: |
| Short jobs elapsed ms    |                733.36 |                             684.63 |
| Registry full-list ms    |                 0.560 |                             15.716 |
| Shell full-list ms       |                 0.446 |                             16.824 |
| Returned tail characters |             6,000,000 |                          5,940,000 |
| Completion callbacks     |                   200 |                                200 |
| Idle polling wakes       |                   600 |                                  0 |
| Idle host CPU us         |                47,273 |                             26,117 |
| Retained host PSS KiB    |               311,177 |                            266,106 |
| Burst ms                 |                 10.57 |                              10.24 |
| Cancel ms                |                 16.66 |                              22.53 |

Raw logs: `/home/shawn/.local/share/opencode/tool-output/tool_0f1c6b3f0001WHt1gizwXlOaOX` (baseline), `tool_0f1c796e3001Bhn4fAJCJV14Bi` (post). Post missed two tails, so its CPU/PSS values are not accepted comparison evidence. The final producer uses one buffered `process.stdout.end` stream and a matched 30 ms startup delay. Returned hydrated bytes are a correctness check, not a resident-retention counter.

## Verification

Final targeted shell/task integration: **33 pass, zero fail**, including delivery
acknowledgement/reload, stdin/EOF, ancestry authorization, pagination, notifications,
4 MiB foreground byte-exact draining and inherited-pipe timeout. Native build
passes in the same command; log `tool_0f1dea4860018BCbq9nAfN66zg`.
Core typecheck and five background-job tests pass (413 assertions), log
`tool_0f1d95414001sbgQ3Snd6BHiPc`.

The initial missing five-byte suffix was independently reproduced as a Bun
producer issue: `console.log` after a large `process.stdout.write` loses the
suffix with a stalled pipe, while buffered `process.stdout.end` delivers exactly
4,194,309 bytes. Raw proof `tool_0f1d0c2cf001IuzC1Dqv7ITyjT`. The regression test
retains both its byte-exact length and final-suffix assertions.

Native version `0.0.0-server-jobs-202609301035`, SHA256
`3174f52d946c85f18ce0a201dc4479606735edce8ad0233af91dac5d60d54121`.
This establishes build provenance, not native performance. Opencode's final
typecheck exits 2 with only the known baseline `/usage` `sdk.globalClient` error,
log `tool_0f1e49414001W7qZjvjDYgZ32J`; no JOBS-specific error remains. Integration
already carries the verified one-line fix `a60296f0fb24655cb3189ed7296e986f60d5eb99`.

The final benchmark closes its scoped subprocesses, disposes AppRuntime and
removes only its own fixture in `finally`, including assertion failures. Raw
measurement artifacts remain. No global server, binary or user credential is used.

Integration touchpoints: Core BackgroundJob interface, legacy instance wrapper,
RuntimeFlags, shell services and tests. Preserve release as explicit opt-in and
report CPU/polling improvement separately from uncertain RAM behavior. Public
Protocol/HttpApi schemas are unchanged.

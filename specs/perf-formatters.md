# Formatter discovery negative cache (table item 8)

## Baseline and scope

- Baseline tree: `e6f0f15a59125fb1775dd081da144ec16c4622aa` (the worktree index, including the user's existing changes).
- Earlier HEAD: `4ca2cc8bb377fcd7d15a3949f6ecced09ca4c311`; HEAD is **not** the measurement baseline.
- Assigned worktree: `/tmp/opencode/perf-batch/formatters`.
- Linux, Bun `1.4.2 (744846f84)`, installed Effect `4.0.0-beta.83`.

The finding is correct. `getCommand` explicitly rediscovered both `undefined` and `false`. It also stored results only after discovery completed, so concurrent requests repeated even successful discovery. Prettier's absent dependency caused repeated package reads; Biome's missing configuration caused repeated upward searches. Capability checks can also launch processes.

## Implementation

Use Effect's native `Cache.makeWith` inside the existing `InstanceState` closure, keyed by formatter descriptor:

- Negative result: five seconds from lookup completion. The next matching `file()` or `status()` after expiry checks again, discovering newly installed tools or newly added formatter configuration/dependencies.
- Successful command: instance lifetime, preserving the existing behavior.
- Failure, defect, or interruption: zero TTL, so the next request retries immediately.
- Concurrent `file()` and `status()` calls share the pending lookup. Different formatters still check in parallel; matching formatters still execute sequentially for each file.
- Instance disposal/reload discards the cache with the existing state. There are no timers, watchers, persistent entries, or cache keys per edited file. Retained entries are bounded by the instance's formatter descriptors.

Configuration selection remains in the existing initialization path. Explicitly disabled formatters never enter discovery, custom commands retain their execution behavior, and a configuration reload reconstructs the state.

## Workload and measurement

`packages/opencode/test/format/format.bench.test.ts` calls the **real Format service**, compiled with the normal layers and scoped temporary instance fixtures. No service implementation or cache is mocked.

Each trial creates an isolated git-root project and 24 real matching files, then makes 120 `Format.file()` requests (five passes over those files). Setup, file creation, and `Format.init()` are outside the measured interval. Cases run sequentially (`concurrency=1`) or as one cold concurrent burst (`concurrency=120`). Every returned value must be `false`.

Three workloads:

1. `missing-config`: `.ts` files, no package.json or Biome config. Real Prettier, Biome and Oxfmt discovery functions; Oxfmt's experimental flag is off.
2. `missing-dependency`: same, with a real `package.json` containing `{}`. This adds a real JSON file read to Prettier's discovery.
3. `process-probe`: `.R` files; the external-discovery seam is `rlang.enabled`, which actually launches `/bin/false` and awaits exit before returning false. This deterministically models a present executable failing its capability probe, without relying on installed R tooling.

Call-through spies count real formatter discovery, `Filesystem.findUp`, and package JSON reads. Every upward search is asserted to stop at the fixture root. Each search therefore performs exactly one target existence probe: `existenceProbes` is derived from this verified one-directory workload, not an OS syscall trace. Child-process probes are counted at the controlled discovery seam. JavaScript cases launch no formatter processes.

There is one warmup plus five measured trials per workload/concurrency pair: 36 trials per run, 30 measured samples. Each trial has a fresh instance/cache. The same requests, discovery fixtures, instrumentation, and assertions were used before and after. Subsequent fixture cleanup only reformatted code and replaced modulo indexing with equivalent repeated-array construction (the same ordered 120 paths).

All measurements were serialized with the shared `flock`. The successful baseline run waited **122974.267044 ms** for the lock; the after run waited **13.574102 ms**. These waits are excluded from all latency figures. An earlier foreground baseline attempt timed out waiting for the lock before producing samples; it is not included.

## Results

Median elapsed time in milliseconds for the complete 120-request workload (five measured trials):

| Workload           | Concurrency | Before ms |  After ms |   Change |
| ------------------ | ----------: | --------: | --------: | -------: |
| Missing config     |           1 |  7.173569 | 15.267925 | +112.84% |
| Missing config     |         120 |  5.950324 |  5.102649 |  -14.25% |
| Missing dependency |           1 | 15.988882 |  5.585947 |  -65.06% |
| Missing dependency |         120 |  6.234174 |  7.701627 |  +23.54% |
| Process probe      |           1 | 94.701940 |  5.492876 |  -94.20% |
| Process probe      |         120 | 36.799194 |  5.181127 |  -85.92% |

Deterministic work counts **per trial**, identical across both concurrency levels and all six trials:

| Workload           | Discovery calls before → after | findUp / existence probes before → after | Config reads before → after | Process probes before → after |
| ------------------ | -----------------------------: | ---------------------------------------: | --------------------------: | ----------------------------: |
| Missing config     |                        360 → 3 |                                  360 → 3 |                       0 → 0 |                         0 → 0 |
| Missing dependency |                        360 → 3 |                                  360 → 3 |                     120 → 1 |                         0 → 0 |
| Process probe      |                        120 → 1 |                                    0 → 0 |                       0 → 0 |                       120 → 1 |

Repeated discovery/probe work is reduced by **99.17%**. This is not a uniform latency win: the cheapest local-filesystem cases can be dominated by Effect cache/concurrency overhead and host scheduling. The sequential missing-config median regressed by 8.09 ms per 120 requests; the concurrent missing-dependency median regressed by 1.47 ms. Process-heavy discovery improves substantially. These regressions and noisy samples are retained rather than selecting only favorable trials.

### Raw sample values

Full unedited runner output, including warmups, assertions, counts and exact floating-point values:

- `/tmp/opencode/perf-batch/formatters-results/before.txt`
- `/tmp/opencode/perf-batch/formatters-results/after.txt`
- `/tmp/opencode/perf-batch/formatters-results/tests.txt`

Measured elapsed-ms samples below are in trial order, excluding warmup:

```text
missing-config / 1
before: 9.435680000000048, 6.844500999999809, 7.173568999999816, 5.814556000000039, 7.225888999999825
after: 18.400020999999924, 6.7887410000003, 218.65293099999963, 15.267925000000105, 8.796153000000231

missing-config / 120
before: 5.3145079999999325, 7.10436000000027, 5.968555000000379, 5.648486000000048, 5.95032399999991
after: 5.4832759999999325, 4.817319000000225, 5.1026489999999285, 4.605070000000069, 5.344017000000349

missing-dependency / 1
before: 12.48351700000012, 16.298131000000012, 13.426793000000089, 27.479032999999617, 15.988882000000103
after: 4.879059000000325, 6.466482000000269, 5.585947000000033, 11.010451999999987, 5.526836000000003

missing-dependency / 120
before: 6.234174000000166, 7.619897999999921, 5.3803680000000895, 6.972610000000259, 6.056814000000031
after: 6.9013410000002295, 11.320781000000352, 9.482338999999683, 7.701626999999917, 6.036954000000151

process-probe / 1
before: 92.105861, 94.70193999999992, 90.33489800000052, 347.5778309999996, 345.3528299999998
after: 7.7088770000000295, 5.426797000000079, 5.492876000000251, 5.027957999999671, 5.739645000000564

process-probe / 120
before: 219.49079299999994, 42.36576100000002, 34.115585999999894, 36.79919400000017, 34.83972300000005
after: 4.62079999999969, 5.351457000000664, 4.035313000000315, 5.181126999999833, 9.216820999999982
```

## Exact commands

All commands use working directory `/tmp/opencode/perf-batch/formatters/packages/opencode`. The before command was executed and completed **before runtime edits**; reproducing it requires the baseline runtime plus the benchmark fixture in an isolated worktree.

```bash
# Before
set -o pipefail && BENCH_WAIT_START=$(date +%s%N) flock /tmp/opencode/perf-batch/bench.lock bash -c 'python3 -c '\''import os,time; print("lock_wait_ms", (time.time_ns()-int(os.environ["BENCH_WAIT_START"]))/1e6, flush=True)'\''; OPENCODE_BENCH_FORMATTERS=1 bun test test/format/format.bench.test.ts' 2>&1 | tee /tmp/opencode/perf-batch/formatters-results/before.txt

# After: identical workload
set -o pipefail && BENCH_WAIT_START=$(date +%s%N) flock /tmp/opencode/perf-batch/bench.lock bash -c 'python3 -c '\''import os,time; print("lock_wait_ms", (time.time_ns()-int(os.environ["BENCH_WAIT_START"]))/1e6, flush=True)'\''; OPENCODE_BENCH_FORMATTERS=1 bun test test/format/format.bench.test.ts' 2>&1 | tee /tmp/opencode/perf-batch/formatters-results/after.txt

# Regression suite
set -o pipefail && bun test test/format/format.test.ts 2>&1 | tee /tmp/opencode/perf-batch/formatters-results/tests.txt

# Formatting (installed dependency only)
bun x --no-install prettier --check /tmp/opencode/perf-batch/formatters/packages/opencode/src/format/index.ts /tmp/opencode/perf-batch/formatters/packages/opencode/test/format/format.test.ts /tmp/opencode/perf-batch/formatters/packages/opencode/test/format/format.bench.test.ts
```

## Correctness verification

`bun test test/format/format.test.ts`: **16 pass, 0 fail, 46 assertions**, 3.26 seconds. Both benchmark runs: **1 pass, 0 fail, 72 assertions** each. Prettier checks pass. The new failure-retry test was also run against the baseline: it failed because a third edit performed discovery again (three calls instead of two).

Added service-level regression coverage:

- Concurrent status plus 20 matching edits share one negative discovery. A newly available formatter remains negative inside the TTL, becomes enabled after advancing the Effect clock six seconds, and actually writes the target file. Its successful command remains cached after another minute.
- Twelve concurrent edits share successful discovery but execute the formatter twelve times, verified by real appended file contents.
- A rejected discovery is surfaced, retried immediately, and a subsequent negative result is cached.
- Interrupting a pending discovery does not poison the next request; synchronization uses explicit readiness promises, not sleeps.
- Instance reload clears negative results immediately. Changing config to manually disable the formatter and reloading prevents further discovery and removes it from status.
- Existing tests continue covering globally disabled/default behavior, separate directories, Ruff/uv disable semantics, parallel checks, custom formatters, and sequential execution for each file.

Broad typechecking, combined build, and deployment remain integration-owner checks per the assignment contract.

## Limitations and residual risks

- Newly available tools/config may take up to five seconds **plus the next discovery-triggering call** to appear. Successful commands retain the previous instance-lifetime caching policy.
- Five measured samples per case are sufficient to confirm deterministic work reduction, not a general filesystem latency distribution. The host had substantial scheduling outliers despite serializing benchmark processes. Locking does not isolate unrelated host activity.
- The process fixture uses `/bin/false` on Linux and measures service discovery sharing, not the full overhead of any particular formatter's executable lookup or process wrapper.
- Filesystem probes are measured in a shallow project with hot local storage. Deep trees or slower filesystems should be evaluated separately; no extrapolated latency claim is made.
- No heap/RSS claim is made. This change retains at most one entry per configured formatter, not per file, and adds no background resource.
- Existing native formatter discovery promises are not abortable. Interruption stops the Effect lookup and permits retries; an already-started external discovery operation may still finish. Instance disposal drops its cache, so it cannot populate a replacement instance's cache.

## Changed paths / integration overlap

- `packages/opencode/src/format/index.ts`
- `packages/opencode/test/format/format.test.ts`
- `packages/opencode/test/format/format.bench.test.ts` (new, opt-in benchmark)
- `specs/perf-formatters.md` (new)

No public API/schema changes or expected overlap with the adjacent LSP/snapshot assignments. Changes are uncommitted in the assigned worktree.

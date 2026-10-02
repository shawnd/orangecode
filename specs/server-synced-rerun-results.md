# Synced shared-server benchmark rerun

Rerun of the default-policy native fleet comparison after merging `shawnd`.
This measures changes from an older shared-server revision, not the server
architecture choice. For current `shawnd` per-terminal backends versus the
merged shared daemon, see
[`server-approach-synced-results.md`](server-approach-synced-results.md).
Two read-only measurement subagents own MINI and full-TUI runs respectively;
the shared benchmark lock serializes all measurements.

## Artifacts and scope

| Arm      | Source commit                              | Version                             | SHA256                                                             |
| -------- | ------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------ |
| Baseline | `8998bdb660d66c31a6e390c1195867b6c303c781` | `0.0.0-shared-server-202609301000`  | `9a789076b6e7dda31664a058604a2aa2b8c26f629ce533e8f2d2ddae79e3a2ee` |
| Synced   | `7e57e73e42d5eeff5ba731dc1eb04adbf6314925` | `0.0.0-shared-server-sync-20260930` | `8a02447126172206a02223fba87032205283f4876fd2860663eb7da6fddb4db3` |

Frozen paths are `/tmp/opencode/shared-server-base-bin/opencode` and
`/tmp/opencode/shared-server-synced-bin/opencode`. Candidate provenance is
alongside its binary. The synced revision incorporates `shawnd` at
`7bd0148203fb641f3413ca9fac13e5bab1bcd75c`, including upstream startup and shared
Location initialization changes. This comparison does not isolate the six
optimization tracks from those upstream changes, nor compare against current
`shawnd` alone.

Three independent alternating paired repeats per mode and client count (one and
four), real PTYs, a warm shared daemon, isolated same-project HOME/XDG/database/
configuration, and five seconds of post-readiness settling. Experimental opt-ins
are disabled. Fleet PSS includes daemon, clients and helper processes exactly
once; worker threads are already included in process PSS. Readiness measures
first prompt paint, not prompt-admission readiness. Post-readiness CPU includes
deferred startup work and is not a long steady-idle measurement. No active-model
or multi-project performance claims follow from this idle workload.

## Results

Values are medians [observed min–max], baseline → synced candidate. These ranges
are not confidence intervals. Client CPU and PSS are aggregate client totals;
readiness is the median client paint time within each run, then summarized over
the three runs.

### Full TUI

| Clients | Metric                 | Baseline               | Synced                   | Median change |
| ------- | ---------------------- | ---------------------- | ------------------------ | ------------: |
| 1       | Fleet PSS MiB          | 584.77 [576.43–599.13] | 584.57 [579.64–587.01]   |        −0.03% |
| 1       | Client PSS MiB         | 141.62 [139.32–141.73] | 146.88 [146.76–147.06]   |        +3.72% |
| 1       | Startup client CPU ms  | 840 [790–910]          | 840 [820–880]            |         0.00% |
| 1       | Settling client CPU ms | 120 [110–120]          | 150 [140–160]            |       +25.00% |
| 1       | Paint readiness ms     | 826.45 [801.38–864.32] | 827.64 [825.17–860.21]   |        +0.14% |
| 4       | Fleet PSS MiB          | 880.97 [873.49–971.91] | 1038.05 [896.04–1105.02] |       +17.83% |
| 4       | Client PSS MiB         | 442.49 [442.24–442.94] | 500.00 [463.09–500.17]   |       +13.00% |
| 4       | Startup client CPU ms  | 3570 [3560–4020]       | 3840 [3780–4020]         |        +7.56% |
| 4       | Settling client CPU ms | 450 [430–490]          | 1260 [610–1300]          |      +180.00% |
| 4       | Paint readiness ms     | 860.70 [855.93–940.14] | 891.00 [888.54–922.96]   |        +3.52% |

Daemon CPU between the pre-attachment sample and the end of settling:
2290 [2220–2450] → 2140 [1940–2240] ms at one client (−6.55%), and
4260 [4190–4680] → 5620 [3420–5710] ms at four clients (+31.92%).

There is no demonstrated full-TUI memory win. One-client fleet memory is flat;
four-client medians regress for memory, CPU and readiness. Wide overlapping PSS
ranges limit conclusions about a stable magnitude. The earlier pre-sync median
improvement must not be substituted for these new results or pooled with them.

The full-TUI matrix completed successfully with 12 valid samples, zero provider
requests, matching before/after hashes, all 42 sampled process IDs absent after
cleanup, and no remaining owned endpoint metadata or daemon sockets. Raw evidence
is `/tmp/opencode/shared-synced-rerun-full-pairs/`, including `samples.json`,
`provider-requests.json`, `hashes-{before,after}.json` and each run's counters/PTYs.
Measurement log:
`/home/shawn/.local/share/opencode/tool-output/tool_0f2c9b7190017TRupSyLHbdBLd`.

### MINI

**Incomplete: two pairs at one client, one pair at four clients.** The matrix
aborted before starting the next sample because `/tmp` exhausted its inodes:

```text
OSError: [Errno 28] No space left on device:
'/tmp/opencode/shared-synced-rerun-mini-pairs/r1-n4-candidate'
```

The error arose in fixture `environment()` → `root.mkdir()`, not daemon startup.
The agent observed about 32 GiB free but only 279 free inodes; parent follow-up
confirmed 229 free inodes and 100% inode utilization. No retry was launched into
the same exhausted filesystem, and no foreign resources were removed.

These partial statistics are descriptive evidence only. Four-client values have
one observation per arm, so there is no repeat-derived range at that count.

| Clients | Metric                 | Baseline                  | Synced                 | Median change |
| ------- | ---------------------- | ------------------------- | ---------------------- | ------------: |
| 1       | Fleet PSS MiB          | 537.92 [537.04–538.81]    | 428.04 [425.89–430.19] |        −20.4% |
| 1       | Client PSS MiB         | 224.08 [224.01–224.15]    | 109.25 [108.92–109.57] |        −51.2% |
| 1       | Startup client CPU ms  | 1435 [1430–1440]          | 600 [590–610]          |        −58.2% |
| 1       | Settling client CPU ms | 40 [40–40]                | 90 [80–100]            |       +125.0% |
| 1       | Paint readiness ms     | 1210.38 [1208.15–1212.62] | 731.95 [718.16–745.73] |        −39.5% |
| 4       | Fleet PSS MiB          | 1067.64                   | 643.02                 |        −39.8% |
| 4       | Client PSS MiB         | 770.17                    | 335.09                 |        −56.5% |
| 4       | Startup client CPU ms  | 7200                      | 3670                   |        −49.0% |
| 4       | Settling client CPU ms | 180                       | 160                    |        −11.1% |
| 4       | Paint readiness ms     | 1471.17                   | 1043.70                |        −29.1% |

Daemon CPU over attachment and settling was 870 [840–900] → 820 [790–850] ms at
one client (−5.7%) and 1170 → 1260 ms at four clients (+7.7%). The partial MINI
memory/startup reductions are consistent with the earlier complete pre-sync
comparison, but cannot replace the requested three-repeat post-sync matrix.

All 18 sampled process IDs were absent after cleanup; all six completed sample
daemon directories had no endpoint metadata or sockets. Binary hashes still
matched the supplied immutable artifacts and valid per-sample records. The
aborted harness did not write aggregate `samples.json`, `hashes-after.json` or
`provider-requests.json`; zero provider requests therefore cannot be verified
from a completed request ledger. Partial records were summarized through
`/dev/stdin` with the unchanged summarizer, without creating a synthetic
completed-run artifact.

Evidence is retained at `/tmp/opencode/shared-synced-rerun-mini-pairs/`, with
`sample.json` in `r0-n1-{baseline,candidate}`, `r0-n4-{baseline,candidate}` and
`r1-n1-{baseline,candidate}`. Measurement log:
`/home/shawn/.local/share/opencode/tool-output/tool_0f2c9b88b001cOl9WFywozMUJF`.
The follow-up is to restore sufficient `/tmp` inode capacity through its resource
owners, then run a fresh complete matrix into a new directory under the same
lock, preserving these failed-run artifacts separately.

## Reproduction

From the integration worktree, use fresh output directories:

```sh
flock /tmp/opencode/shared-server-bench.lock env PYTHONDONTWRITEBYTECODE=1 python script/server-mini-bench.py --baseline /tmp/opencode/shared-server-base-bin/opencode --candidate /tmp/opencode/shared-server-synced-bin/opencode --out /tmp/opencode/shared-synced-rerun-mini-pairs --repeats 3 --settle 5
flock /tmp/opencode/shared-server-bench.lock env PYTHONDONTWRITEBYTECODE=1 python script/server-mini-bench.py --baseline /tmp/opencode/shared-server-base-bin/opencode --candidate /tmp/opencode/shared-server-synced-bin/opencode --out /tmp/opencode/shared-synced-rerun-full-pairs --repeats 3 --settle 5 --full
python script/summarize-server-mini.py /tmp/opencode/shared-synced-rerun-mini-pairs/samples.json
python script/summarize-server-mini.py /tmp/opencode/shared-synced-rerun-full-pairs/samples.json
```

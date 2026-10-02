# Shared-server architecture comparison after the `shawnd` merge

This is the architecture-level comparison: current `shawnd`'s backend Worker per
full-TUI process versus the merged shared-server branch's single authenticated
backend daemon shared across full-TUI processes. Earlier optimization reruns used
an older shared-server baseline and do not answer this question.

## Pinned source and artifacts

- Per-terminal backend: `shawnd` at
  `7bd0148203fb641f3413ca9fac13e5bab1bcd75c`.
- Shared daemon: production source at
  `7e57e73e42d5eeff5ba731dc1eb04adbf6314925`, which incorporates that same
  `shawnd` revision. Later report-only commits do not change this artifact.
- Frozen artifact root:
  `/home/shawn/code/opencode-server-bench-results/artifacts/`.
- Shared artifact SHA256:
  `8a02447126172206a02223fba87032205283f4876fd2860663eb7da6fddb4db3`.
- Per-terminal artifact SHA256:
  `7f2d3815b2bf9c8d37ff25c8dcc42eb4743c4a0e8c025c101b819aa89f3d6b17`.

Artifacts are `shawnd/opencode` and `shared-server/opencode`
under that root, with provenance alongside each binary. Versions are
`0.0.0-shawnd-server-bench-20260930` and
`0.0.0-shared-server-sync-20260930`, respectively. Both use the same Bun 1.4.2
native build command with embedded web UI skipped.

The baseline is built in a dedicated detached worktree. The original `shawnd`
checkout, installed binaries and running sessions remain independently maintained.
Persistent evidence and isolated fixtures use disk-backed storage outside all git
worktrees because `/tmp` is inode-exhausted.

## Measurement plan

- Both arms launch the normal full-TUI project command. Neither arm is an attached
  MINI client. The shared daemon is created by the first TUI, so its cold startup
  cost belongs to the shared architecture.
- Same local deterministic provider, catalog/configuration, fresh HOME/XDG/
  database/project fixtures, terminal geometry and readiness criteria per arm.
  Experimental resource/event opt-ins remain disabled.
- One, two, four, eight, sixteen and thirty-two terminals, three independent paired repeats with
  alternating arm order, serialized by `/tmp/opencode/shared-server-bench.lock`.
- First prompt paint is recorded separately from usable backend readiness;
  early input can paint before the backend finishes loading in both branches.
  Clients launch sequentially, each reaching readiness before the next launch.
  Readiness requires a fresh per-client presentation snapshot with the configured
  provider/model selection and catalog, plus its visibly rendered model name.
  The snapshot producer is guarded by `sync.ready` and `local.model.ready` in
  `packages/tui/src/component/prompt/index.tsx`. Its 100 ms debounced persistence
  makes this an observable readiness proxy, rather than the exact instant either
  store becomes ready.
- Fleet PSS includes all client, daemon and helper processes exactly once.
  Backend Worker threads already contribute to their owning process's PSS.
  Record CPU, RSS and swap countermetrics, and preserve observed ranges.
  After twelve seconds of settling, take five samples two seconds apart. CPU
  counters include observed processes; CPU from unobserved exited helpers can be
  missed. Large fleets require eight GiB of remaining available-memory headroom.
- Separate four-client active local-provider workload verifies concurrency and
  measures the fleet while streams are held open, followed by completion and
  owned-process cleanup checks.

## Collected results

The user stopped the matrix after sufficient idle-fleet data was collected.
Counts one through sixteen completed three paired repeats. Thirty-two completed
two valid paired repeats, rather than the planned three.
The planned active four-client workload was not reached. No active-workload or
multi-project performance conclusion follows from these idle, same-project runs.

Fleet PSS in MiB, medians [observed minimum–maximum]; percentage change compares
the arm medians. Ranges are descriptive, not confidence intervals.

| Terminals |         Per-terminal backend |             Shared daemon | Change |
| --------: | ---------------------------: | ------------------------: | -----: |
|         1 |       455.81 [453.77–457.17] |    442.73 [439.39–456.63] |  −2.9% |
|         2 |       783.38 [781.48–784.70] |    566.55 [559.91–569.28] | −27.7% |
|         4 |    1459.38 [1435.72–1459.48] |    770.35 [760.10–773.05] | −47.2% |
|         8 |    2776.28 [2774.40–2779.69] | 1178.66 [1175.28–1181.74] | −57.5% |
|        16 |    5429.88 [5427.74–5434.96] | 2000.11 [1998.31–2008.67] | −63.2% |
|      32\* | 10646.56 [10583.67–10709.45] | 3690.66 [3688.19–3693.13] | −65.3% |

\* Two paired repeats. The third baseline run recorded measurements, but the
user-requested interruption landed in cleanup; that run remains excluded.

At eight terminals, fleet startup CPU was 36.27 → 13.13 CPU-seconds, while the
first client's observable backend-ready time was 1.657 → 2.009 seconds. Later
clients were ready in 1.811 → 1.006 seconds. At sixteen terminals the corresponding
values were 68.82 → 25.59 CPU-seconds, 1.709 → 2.008 seconds for the first client,
and 1.659 → 1.107 seconds for later clients. These are medians; first-client daemon
startup adds latency even though reuse reduces later-client cost. Startup CPU
includes earlier clients' activity during sequential fleet admission.

Raw evidence is `/home/shawn/code/opencode-server-bench-results/sa2/results.json`
with preserved per-run PTYs, presentation snapshots, environment, provider ledger,
process identities and counters. The initial `sa1` failure was a harness parser
error: the address header in `smaps_rollup` was treated as an integer. The parser
was corrected and `sa1` remains excluded and preserved.

Post-stop verification checked all 363 saved PID/start-time identities across
35 fixtures: every PID and the harness were absent, and the benchmark lock could
be acquired exclusively. No further signals were needed. Raw aggregate and all
35 per-run records remained unchanged. Verification evidence is
`sa2/stop-verification.json`; endpoint removal was not verified.

No numerical conclusions from the older shared-server optimization baseline are
carried into this report.

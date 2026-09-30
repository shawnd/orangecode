# Shared-server experiment integration

All six experiment implementations are integrated into `shared-server`.
This report distinguishes default changes from opt-in experiments and their
individual measurements from the final combined native verification.

## Frozen artifacts

| Artifact   | Source commit                              | SHA256                                                             |
| ---------- | ------------------------------------------ | ------------------------------------------------------------------ |
| Baseline   | `8998bdb660d66c31a6e390c1195867b6c303c781` | `9a789076b6e7dda31664a058604a2aa2b8c26f629ce533e8f2d2ddae79e3a2ee` |
| Integrated | `fc8d7ade9417b3d93a526afb841bccb07acae2d4` | `894a5486bbf6e3b30ea3b01df7ef89e9c22a6a1e2aef3e3a122bc87ca638d1b6` |

Binaries are `/tmp/opencode/shared-server-base-bin/opencode` and
`/tmp/opencode/shared-server-integrated-bin/opencode`. Integrated version:
`0.0.0-shared-server-integrated-202609301110`.
The integration build was worktree-local, using
`bun run script/build.ts --single --skip-install --skip-embed-web-ui` from
`packages/opencode`. Its provenance JSON is alongside the frozen binary.
At build time only the external Python benchmark/flow harness changes were
uncommitted; compiled production sources and generated clients matched the
recorded commit. Subsequent harness/report commits do not change this binary.

## Defaults and opt-ins

| Track     | Integrated policy                                                        | Individual evidence and countermetrics                                                                                                                             |
| --------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MINI      | Lean attached runtime, default                                           | Three paired native runs: four-client warm idle fleet PSS 1077.09 → 648.12 MiB; startup client CPU 6770 → 2590 ms. Actual database-open absence traced separately. |
| QUEUES    | Lossless client byte/count batches, default; server limits opt-in        | Source burst backlog 125.32 → 0.94 MiB; all 2000 events delivered. Normal source CPU +5.3%. Server `bounded-v1` requires explicit resync-aware callers.            |
| JOBS      | Dirty notifications replace idle polling, default; output release opt-in | Service idle CPU 48590 → 18754 µs, 600 → 0 polling wakes. Short jobs +6.2% elapsed; no established default RAM win. Release increases hydration/list latency.      |
| PARALLEL  | Native worker executor opt-in                                            | Compiled search throughput 70 → 115 requests/s and control p95 288 → 176 ms; fleet PSS +11.7%. Source mixed-grep median latency regressed.                         |
| LIFETIMES | Leased search-only idle retirement opt-in                                | Worker/legacy idle PSS 706.55 → 646.66 MiB, revisit readiness 3.45 → 38.18 ms. Direct-backend memory benefit inconsistent. Whole Location graphs remain retained.  |
| EVENTS    | Selective transcript interests opt-in                                    | Three native paired SDK-stream runs: transcript events 195 → 117 and JSON bytes 84285 → 51089. Full-TUI active fleet benefits remain unestablished.                |

Individual provenance, ranges, commands and raw artifacts are in
`server-{mini,queues,jobs,parallel,lifetimes,events}-results.md`.
These measurements are not additive savings estimates.

Opt-ins:

- `OPENCODE_EXPERIMENTAL_EVENT_INTEREST=1`: client-local session interests.
- `x-opencode-event-buffer: bounded-v1`: recovery-aware SSE consumers only;
  the TUI does not request this header.
- `OPENCODE_EXPERIMENTAL_JOB_OUTPUT_RELEASE=1`: completed job-output release.
- `OPENCODE_EXPERIMENTAL_FFF_WORKER=1`, `OPENCODE_FFF_WORKERS=1..8`:
  bounded native workers, default pool size two when enabled.
- `OPENCODE_EXPERIMENTAL_SEARCH_IDLE_MS`: positive search-only idle timeout,
  at most 2147483647; omitted/invalid values disable retirement.

## Integration reconciliation

- `/usage` now uses the connected `sdk.client`.
- Daemon profile identity includes normalized effective worker, search-idle
  and job-output-release policies. Disabled policies preserve the previous key;
  explicit daemon-directory overrides retain their established semantics.
- EVENTS and QUEUES retain byte/count-limited lossless client batches,
  asynchronous subscription cleanup, descendant-ready handshakes and hydration
  sequencing together.
- Simultaneous bounded/selective SSE requests filter after descendant seeding,
  bound the temporary seed backlog, and retain explicit overflow termination.
  Cancellation during effectful subscription releases its acquired listener.
- Both client generators ran successfully after merging public API changes;
  regenerated outputs were reproducible with no additional tracked diff.
- A newly merged legacy hydration test now supplies the complete generated
  `message.part.updated` event contract (`sessionID`, `part`, `time`).

## Combined source verification

All eight package typechecks passed: OpenCode, TUI, Core, Server, Protocol,
Schema, Client and JavaScript SDK.

| Suite                                                                                | Passed | Skipped | Assertions |
| ------------------------------------------------------------------------------------ | -----: | ------: | ---------: |
| OpenCode CLI/run, background shell/task, SSE interests/buffering and daemon identity |    249 |       5 |        857 |
| TUI interests, hydration, approvals, batching and subscription cleanup               |     27 |       0 |        154 |
| Core native workers/search leases, jobs, PTYs, approvals and session execution       |    189 |       0 |       1374 |

Source verification logs under `/home/shawn/.local/share/opencode/tool-output/`:
`tool_0f1f46f0c001vMp7QVYrQnQhLK`, `tool_0f1f5cab0001w5lUdtfXfuDPsh`,
`tool_0f1f48ba8001TGNiS2T8VxDFe5`, `tool_0f1f4a78c001MHXY5Rn3kV4Xay`.
TUI tests emitted missing initial fixture KV-file diagnostics but passed;
the test fixture creates state as needed.

## Combined native verification and fleet comparison

The frozen integrated binary passed:

- MINI: actual footer permission approval, bash tool completion, visible provider
  response, durable resume replay, fork history, attached headless admission and
  standalone headless JSON response.
- Full TUI: the same flow passed for both frozen baseline and integrated binaries.
- Combined resource policies: two FFF workers, 200 ms search-idle retirement and
  job-output release enabled together. Fixture search succeeded before and after
  crossing the retirement boundary; the MINI flow above then passed. This is
  coexistence coverage, not a native completed-background-job release-cycle test.
- Compiled V2 event-interest probe: one test, 14 assertions, covering durable
  tool/question execution, transcript isolation, seeded descendants and snapshots.

Native flow artifacts:
`/tmp/opencode/shared-integrated-mini-flow/result.json`,
`/tmp/opencode/shared-integrated-full-flow-{base2,after2}/result.json`,
`/tmp/opencode/shared-integrated-policies-flow2/result.json`, and
`/tmp/opencode/shared-integrated-events-native.json`.

Two failed harness attempts are retained. The first full-TUI attempt assumed a
Session existed on mount; full TUI creates it on submission. The first policy
flow sent input immediately after paint and observed `input queue unavailable`:
MINI's async transport/queue wiring can finish after paint. The untimed flow now
drains for one second before submission. Production startup behavior is unchanged;
benchmark readiness below measures first prompt paint, not admission readiness.

### Default-policy native fleet measurements

Three independent alternating paired repeats for each mode/client count, using
one warm daemon and one isolated same-project fixture per arm, real PTYs, and a
five-second post-readiness settling interval. Both arms used the same harness;
opt-in experiments were disabled. No provider calls, forced GC or heap snapshots
occurred in these measurements. Fleet PSS counts daemon, clients and descendants
exactly once. All 84 sampled process IDs were absent after cleanup; both binary
hashes matched before and after the runs.

Values are medians, baseline → integrated. Readiness is the median client paint
time within each run, then the median across runs. CPU is summed across clients.

| Mode     | Clients |    Fleet PSS MiB |  Client PSS MiB | Startup client CPU ms | Paint readiness ms |
| -------- | ------: | ---------------: | --------------: | --------------------: | -----------------: |
| MINI     |       1 |  536.20 → 425.77 | 223.40 → 109.13 |            1500 → 560 |   1263.01 → 706.48 |
| MINI     |       4 | 1080.95 → 644.95 | 779.17 → 335.02 |           6510 → 2450 |   1378.91 → 737.78 |
| Full TUI |       1 |  578.45 → 575.84 | 140.88 → 141.73 |             830 → 820 |    836.85 → 817.80 |
| Full TUI |       4 | 1013.44 → 921.80 | 480.35 → 465.35 |           3950 → 3720 |    939.25 → 891.02 |

Observed fleet PSS ranges, not confidence intervals:

| Mode     | Clients |    Baseline MiB | Integrated MiB |
| -------- | ------: | --------------: | -------------: |
| MINI     |       1 |   536.01–545.92 |  423.79–432.15 |
| MINI     |       4 | 1079.67–1083.08 |  638.94–650.00 |
| Full TUI |       1 |   578.11–586.27 |  574.81–583.98 |
| Full TUI |       4 | 1011.02–1022.50 | 878.78–1031.54 |

The clear combined default benefit is MINI: four-client fleet PSS fell 40.3%,
startup client CPU fell 62.4%, and paint readiness fell 46.5%. One-client fleet
PSS fell 20.6%. Full-TUI one-client memory is effectively flat. Its four-client
median is 9.0% lower, but the wide overlapping range includes a paired regression;
these three runs do not establish a reliable full-TUI memory improvement.

Countermetric: client CPU between readiness sampling and the end of the five-second
settle increased for MINI. One-client medians/ranges were 50 [40–60] → 70 [70–70]
ms; four-client totals were 170 [140–190] → 360 [310–470] ms. This interval includes
deferred startup work and is not a long steady-idle measurement. Full-TUI values
were 110 [110–170] → 110 [110–130] ms at one client and
1090 [980–1100] → 790 [530–1120] ms at four clients. MINI's large startup CPU
reduction remains after including this settling work, but the higher post-paint
CPU must not be presented as an idle-CPU win.

Raw samples, per-process counters, PTYs and before/after hashes:
`/tmp/opencode/shared-integrated-{mini,full}-pairs/`. Summarize with
`python script/summarize-server-mini.py <directory>/samples.json`.

Reproduction from the integration worktree, with fresh output directories:

```sh
flock /tmp/opencode/shared-server-bench.lock python script/server-mini-flow.py --binary /tmp/opencode/shared-server-integrated-bin/opencode --out /tmp/opencode/integration-flow-repro
flock /tmp/opencode/shared-server-bench.lock python script/server-mini-flow.py --binary /tmp/opencode/shared-server-integrated-bin/opencode --full --out /tmp/opencode/integration-full-flow-repro
flock /tmp/opencode/shared-server-bench.lock python script/server-mini-flow.py --binary /tmp/opencode/shared-server-integrated-bin/opencode --resource-policies --out /tmp/opencode/integration-policy-flow-repro
flock /tmp/opencode/shared-server-bench.lock python script/server-mini-bench.py --baseline /tmp/opencode/shared-server-base-bin/opencode --candidate /tmp/opencode/shared-server-integrated-bin/opencode --out /tmp/opencode/integration-mini-repro --repeats 3 --settle 5
flock /tmp/opencode/shared-server-bench.lock python script/server-mini-bench.py --baseline /tmp/opencode/shared-server-base-bin/opencode --candidate /tmp/opencode/shared-server-integrated-bin/opencode --out /tmp/opencode/integration-full-repro --repeats 3 --settle 5 --full
```

From `packages/opencode`:

```sh
flock /tmp/opencode/shared-server-bench.lock env NATIVE_EVENT_BIN=/tmp/opencode/shared-server-integrated-bin/opencode bun test test/server/native-event-interest.test.ts --timeout 60000
```

## Remaining boundaries

- Controller/observer client-close cancellation and daemon replacement handoff
  remain a separate plan in `shared-client-close.md`.
- Search retirement does not retire whole Location service graphs. Active-work
  leases and background-job/PTY/approval protection must precede broader eviction.
- Selective events need additional live multi-project navigation/reconnect and
  task-created descendant coverage before default enablement. Bounded SSE lacks
  authoritative TUI recovery/snapshot fences and remains externally negotiated.
- Attached headless flow checks durable user-prompt admission. It does not prove
  attached stdout streaming or response completion; local headless flow checks
  the deterministic JSON response.
- Idle same-project fleet results do not establish active multi-project fleet
  savings. Opt-in worker, lifetime and output-release costs remain explicit.
- Previously identified security/configuration and foreign-MCP/reminder ownership
  issues are outside these optimization experiments. Resource-policy profile
  identity does not completely fingerprint all credential/configuration inputs.

## Subsequent synchronization with `shawnd`

Merged `shawnd` at `7bd0148203fb641f3413ca9fac13e5bab1bcd75c` into
`shared-server`, preserving the six experiments. Reconciliation retains early
startup input and parallel UI/config imports alongside the shared daemon, and
combines shutdown cancellation with lossless batching and selective interests.
The explicit-network worker retains awaited, idempotent cleanup. Its failed-
validation fixture now explicitly selects that worker rather than a persistent
shared daemon. Background tasks inherit `shawnd`'s enabled default; job-output
release remains independently opt-in.

Both generators completed; legacy SDK regeneration also supplies the merged V2
session-list agent filter. All eight package typechecks passed. Focused tests:
OpenCode 121, TUI 35, Core 9; 165 passed, zero failures. The explicit-worker
shutdown test additionally passed after the fixture adjustment. The temporary
daemon created by the earlier fixture invocation was identified by its isolated
test database/configuration and stopped.

The synchronized native build is worktree-local at
`packages/opencode/dist/opencode-linux-x64/bin/opencode`, version
`0.0.0-shared-server-sync-20260930`, SHA256
`8a02447126172206a02223fba87032205283f4876fd2860663eb7da6fddb4db3`.
Both rebuilt MINI and full-TUI flows passed footer approval, tool completion,
visible response, resume, fork and the headless checks described above. Artifacts:
`/tmp/opencode/shared-shawnd-sync-{mini,full}-flow/result.json`. Their owned
daemon/client process IDs and endpoint metadata were absent after cleanup.
The frozen binaries and performance measurements above still describe the
pre-sync revisions; they are not measurements of this subsequent merge.

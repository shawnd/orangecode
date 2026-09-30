# QUEUES experiment — verified client batching; server limits opt-in

## Recommendation and hypothesis

**Accept lossless byte-aware client batching by default. Accept server SSE limits
only as an explicit opt-in for external callers with their own safe recovery.**
Do not enable bounded SSE in the TUI until authoritative snapshot recovery exists.

Hypothesis: bounding queued serialized bytes/events should reduce burst/slow-reader
retention without suppressing correct client events. Countermetrics: normal-case
CPU, elapsed time and p99 event delivery. Three independent, alternating paired
repeats support the client mechanism and the opt-in server mechanism. They do not
establish whole-daemon/fleet savings or safe automatic recovery after a gap.

The client burst delivered every event and reduced observed maximum pending
payload from 125.32 MiB to 0.94 MiB. Burst p99 fell from median 162.65 ms to 3.61 ms.
Normal client p99 remained approximately 16.1 ms; median CPU increased **5.3%**
(69.48 → 73.18 ms). Accept that measured overhead for lossless burst protection.
The default server path retains its unbounded behavior; its memory improvement is
not claimed. Only the bounded opt-in detached on overflow and stayed below 4 MiB.

## Implementation and contract

- Implementation commit: `890cafa33dbd35c8869c2f65bff631f611939424`
  (`feat(queues): bound client batches and add opt-in SSE limits`).
- Client `event-batch.ts` defaults to 1 MiB / 256 events. An ordinary producer
  flushes an ordered prefix synchronously before exceeding its pending budget.
  Oversize singletons deliver directly. No coalescing, delta dropping or hydration
  is involved. A detached prefix currently being applied is additional live state.
- Reentrant injected sources prioritize losslessness and ordering: their tail can
  temporarily exceed the budget while the consumer applies its current prefix,
  then drains in the outer flush. This is explicitly not a hard memory bound for
  arbitrary reentrant producers or expensive rendering/store consumers.
- `SDKProvider` keeps timer batching and now detaches asynchronous injected-source
  subscriptions on disposal, including a subscription resolving after disposal.
- Server `event-buffer.ts` defaults to 4 MiB / 4096 queued events. It retains
  immutable serialized UTF-8 payloads, checks actual `Queue.offerUnsafe` failure,
  installs its subscription before `server.connected`, and releases the source
  immediately on overflow/offer failure rather than after the reader drains.
- Only exact request header `x-opencode-event-buffer: bounded-v1` negotiates the
  bounded stream; the response acknowledges `X-Opencode-Event-Buffer: bounded-v1`.
  Missing/unknown values keep the original stream.
- On termination: accepted ordered prefix, exactly one SSE `opencode.resync` frame
  containing `{"resync":true,"reason":"overflow"}` or reason `offer-failed`,
  then EOF. The terminal control payload has no ordinary event `payload` wrapper.
  A caller must stop ordinary delta application and recover authoritatively;
  blindly reconnecting is unsafe. TCP delivery of the terminal frame is not
  guaranteed to a client that disconnects before draining the accepted prefix.
- Budgets measure pending serialized payload, excluding SSE framing, transport
  buffers, in-flight pulled records, object overhead and transient serialization.
  The limits do not cap total process memory.
- Withdrawn quiet-window recovery is preserved only in
  `specs/server-queues-recovery-draft.md`. No TUI bounded-header negotiation,
  `OPENCODE_EXPERIMENTAL_BOUNDED_EVENTS` switch or runtime recovery draft remains.
  A quiet receive window is not a snapshot/live cursor fence. Legacy/V2 owners,
  location-aware pending approvals/questions and in-flight hydration fencing are
  prerequisites for default bounded SSE.

## Provenance and measurement scope

- Worktree `/home/shawn/code/opencode-server-queues`, branch `server-queues`.
- Immutable baseline `8998bdb660d66c31a6e390c1195867b6c303c781`.
- Bun `1.4.2 (744846f84)`, Linux x64/glibc. Fresh process per sample, shared OS lock
  held across bundle builds and the entire 30-sample matrix. Repeat order:
  base→after, after→base, base→after; the after server includes default and opt-in.
- `freeze-queues-bench.ts` builds identical harnesses in both arms. Baseline
  overrides only the production `global.ts` or `SDKProvider` with immutable git
  source; the handler is exported for direct invocation. Other dependencies are
  the same worktree-local versions. Solid transformation and native assets are
  bundled for both client arms. Keep each complete bundle directory together.
- Server harness calls the production response/subscription/SSE encoder through a
  real Bun HTTP listener and fetch reader. The normal workload emits 1000 unique
  events with 256-byte text at approximately 1 ms intervals. Slow mode emits 2000
  unique events with 64 KiB text synchronously, stalls the reader, allows 50 ms for
  writer backpressure, samples PSS, then cancels. `received: 0` in slow mode is
  intentional: it does not parse/drain the workload. Prefix/terminal correctness
  is independently tested through the actual HttpApi route.
- Client harness uses actual `SDKProvider`, OpenTUI test rendering, injected source
  and emitter. Its `slow` mode is a synchronous producer burst, not slow rendering
  or a slow network reader. The listener performs lightweight accounting rather
  than full history/store hydration. Outstanding offered-minus-applied serialized
  bytes/events at producer boundaries measure pending client batch backlog.
- Server PSS includes producer, server, fetch client and runtime in one process;
  client PSS includes its harness/runtime/renderer. These are service-level
  measurements, not daemon-only or whole-fleet memory. PSS is sampled at specified
  points, not continuously sampled peak PSS. No forced GC or heap snapshots.
- Timed CPU includes accounting/serialization and PSS reads; server CPU also
  includes the settle interval. Elapsed/p99 start after subscription readiness.
  Module startup is outside the timed workload; every sample otherwise starts
  fresh. No real provider, user credentials, project or model request is used.

### Frozen artifacts (SHA-256)

| Artifact                                                          | SHA-256                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `/tmp/opencode/queues-paired-base/bench-queues.js`                | `21af6b27c7c68522a0237db16e1e087b729e56d0323a1012925a40f1bada3e7e` |
| `/tmp/opencode/queues-paired-after/bench-queues.js`               | `66f7bcc4a65b4d5bfb1709c501f36497db32cf0f7758208158ce38c697355622` |
| `/tmp/opencode/queues-client-base/bench-queues-client.js`         | `d7928a6a3ca02dcac4ecc3df0813bfa95d442b45969e075a8d7a2ed027475e6e` |
| `/tmp/opencode/queues-client-after/bench-queues-client.js`        | `0bd8354e6b5d149aedb96640270d95b7d29a58f65a6fa27e33d5d62c39f9b031` |
| Original `/tmp/opencode/queues-base-bundle/bench-queues.js`       | `5504308c2bad577fb714303cf4fb453f587277fd68645d4a8fe3d1e6c7cff1e2` |
| Coordinator `/tmp/opencode/shared-server-base-bin/opencode`       | `9a789076b6e7dda31664a058604a2aa2b8c26f629ce533e8f2d2ddae79e3a2ee` |
| Worktree `packages/opencode/dist/opencode-linux-x64/bin/opencode` | `2fad81fc7b2938731c1f256dab8f1437729ed1b114b9884e153b73d7a019f56e` |

Coordinator CLI version: `0.0.0-shared-server-202609301000`; final worktree CLI
version: `0.0.0-server-queues-202609301026`. These binaries establish build/baseline
provenance; paired measurements execute the four frozen harness bundles.

## Results

Every entry is median **[observed minimum, maximum]** across three samples.
Ranges are not confidence intervals. PSS is KiB; CPU, elapsed and p99 are ms.
All normal server arms received 1000/1000 events. Every client arm received all
events (1000 normal; 2000 burst). All server samples ended with zero bus listeners.
Injected-source cleanup was zero in the baseline and exactly once after the fix.

### Client

| Workload / arm  |    After-drain PSS KiB |                    CPU ms |                   Elapsed ms |                    p99 ms |
| --------------- | ---------------------: | ------------------------: | ---------------------------: | ------------------------: |
| Normal baseline |    45486 [45034,45602] |    69.477 [65.696,73.136] | 1101.757 [1101.751,1101.838] |    16.104 [16.098,16.105] |
| Normal after    |    45406 [45346,45618] |    73.176 [70.600,78.664] | 1101.960 [1089.132,1102.142] |    16.110 [16.108,16.117] |
| Burst baseline  | 337274 [323485,338234] | 293.383 [277.350,299.911] |    236.013 [219.853,244.592] | 162.647 [148.876,171.355] |
| Burst after     |  106238 [99639,113341] | 228.319 [193.783,254.595] |    153.098 [126.699,172.875] |       3.615 [2.541,4.047] |

| Workload / arm  |           Maximum pending bytes | Maximum pending events |
| --------------- | ------------------------------: | ---------------------: |
| Normal baseline |                7296 [6855,7296] |             16 [15,16] |
| Normal after    |                7296 [7294,7296] |             16 [16,16] |
| Burst baseline  | 131406942 [131406918,131406942] |       1999 [1999,1999] |
| Burst after     |          986055 [986055,986055] |             15 [15,15] |

Burst after-drain PSS median is 68.5% lower. PSS growth from pre-workload to drain
is 296464 [291870,297329] KiB baseline versus 68280 [65392,72628] KiB after.
Normal CPU overhead is exposed above; normal latency is effectively unchanged
at the precision meaningful for this three-repeat service-level workload.

### Server

| Workload / arm       |   After-settle PSS KiB |                    CPU ms |                   Elapsed ms |              p99 ms |
| -------------------- | ---------------------: | ------------------------: | ---------------------------: | ------------------: |
| Normal baseline      | 171692 [171328,173917] | 240.202 [209.891,247.678] | 1103.118 [1090.876,1106.495] | 0.377 [0.270,0.658] |
| Normal default after | 172296 [171448,172860] | 225.892 [225.024,241.556] | 1096.705 [1091.560,1105.621] | 0.301 [0.273,0.425] |
| Normal bounded after | 171036 [170148,171588] | 221.862 [221.441,227.497] | 1095.186 [1091.710,1096.547] | 0.372 [0.292,0.448] |
| Slow baseline        | 615856 [611789,616800] | 496.935 [459.334,500.132] |    170.179 [169.434,178.759] |         Not drained |
| Slow default after   | 612568 [609360,623493] | 485.515 [469.966,502.690] |    175.316 [165.075,175.631] |         Not drained |
| Slow bounded after   | 269432 [263426,274488] | 204.161 [186.456,209.146] |    135.719 [128.097,155.194] |         Not drained |

Bounded normal maximum backlog is 408 bytes / 1 event in every repeat. Bounded
slow maximum backlog is 4138124 [4138124,4138127] bytes / 63 events, terminating
with reason `overflow` in every repeat. Baseline/default maximum queue retention
is not instrumented: approximately 131.3 MB offered is workload volume, **not** an
observed maximum retained queue size.

Bounded slow settled PSS median is 56.3% lower than baseline. PSS growth is
457220 [452908,457276] KiB baseline, 457787 [453864,465124] KiB default after and
115792 [109896,116071] KiB bounded after. The opt-in result includes early source
detachment: remaining offered events are deliberately outside the accepted
prefix and require caller recovery. It is not lossless continued SSE delivery.
Normal server ranges overlap; do not interpret small timing differences as a
demonstrated default throughput improvement.

### Raw evidence

- All 30 samples, frozen hashes and successful runner exit:
  `/home/shawn/.local/share/opencode/tool-output/tool_0f1d8bf54001OKJ3NjxfWHmCz5.stdout.log`
  (samples are lines 11–40; companion combined/stderr logs share this prefix).
- Initial preimplementation source baseline:
  `/home/shawn/.local/share/opencode/tool-output/tool_0f1c57226001pRZe8QWNLXUqHv.stdout.log`.
  It is historical evidence, not a final paired sample. Its old `peakPssKB` label
  represented a settled sample; the final harness corrects that naming.
- Earlier attempts hit bundle platform-resolution/relative-native-path issues;
  final bundles freeze host platform/libc and execute from their own directory.
  Failed attempts are not included in any reported median/range.

## Exact reproduction

From worktree `packages/opencode` (existing output parents `/tmp/opencode`):

```sh
flock /tmp/opencode/shared-server-bench.lock bash -lc 'bun run script/freeze-queues-bench.ts base /tmp/opencode/queues-paired-base && bun run script/freeze-queues-bench.ts after /tmp/opencode/queues-paired-after && bun run script/freeze-queues-bench.ts base /tmp/opencode/queues-client-base client && bun run script/freeze-queues-bench.ts after /tmp/opencode/queues-client-after client && sha256sum /tmp/opencode/queues-base-bundle/bench-queues.js /tmp/opencode/queues-paired-base/bench-queues.js /tmp/opencode/queues-paired-after/bench-queues.js /tmp/opencode/queues-client-base/bench-queues-client.js /tmp/opencode/queues-client-after/bench-queues-client.js /tmp/opencode/shared-server-base-bin/opencode && bun run script/run-queues-bench.ts'

flock /tmp/opencode/shared-server-bench.lock bash -lc 'bun test test/server/event-buffer.test.ts test/server/httpapi-global.test.ts && bun typecheck'

flock /tmp/opencode/shared-server-bench.lock bash -lc 'bun run script/build.ts --single --skip-install --skip-embed-web-ui && dist/opencode-linux-x64/bin/opencode --version && sha256sum dist/opencode-linux-x64/bin/opencode'
```

From worktree `packages/tui`:

```sh
flock /tmp/opencode/shared-server-bench.lock bash -lc 'bun test test/cli/tui/event-batch.test.ts test/cli/tui/sdk-batch.test.tsx test/cli/tui/data.test.tsx && bun typecheck'
```

Runner subprocesses have a 30-second timeout and set cwd to the appropriate bundle
directory, required for relative native library paths. Later native builds embed
a new timestamp/version and will have a different binary hash.

## Correctness, build and integration

- Final server tests: **12 pass, 0 fail, 25 assertions**, including immutable
  ordered prefix, UTF-8 oversize, real failed offer, overflow while take waits,
  cancellation/early-close cleanup, HTTP negotiation/resync/EOF and an unknown
  header preserving more than 4096 legacy events.
- Final TUI tests: **15 pass, 0 fail, 61 assertions**, including byte/count bursts,
  oversize delivery, critical approval/status/history event order, reentrant
  prefix ordering, actual provider timer drain, late subscription disposal and
  existing `data.test.tsx` integration coverage.
- Both package `bun typecheck` runs report only the documented baseline
  `packages/tui/src/component/dialog-usage-stats.tsx(43,36)` missing
  `sdk.globalClient` error. They exit 2; full package checks are **not passing**.
  No QUEUES-specific type error remains. Parent must reconcile the shared fix.
- Final native CLI build and version smoke test **passed**, exit 0.
- Final server verification log:
  `/home/shawn/.local/share/opencode/tool-output/tool_0f1d8bf64001YO7sJ3wmQ3p0Ql`.
- Final TUI verification log:
  `/home/shawn/.local/share/opencode/tool-output/tool_0f1d8bf5c001wIC31ztntykk5q`.
- Final native build/version/hash log:
  `/home/shawn/.local/share/opencode/tool-output/tool_0f1d91b9e001k4VJPYa79E02ca`.
- Integration overlap: EVENTS also touches handler `global.ts` and TUI `sdk.tsx`.
  Parent should preserve its filtering/session-select changes while applying the
  lossless batch and exact opt-in negotiation. Public typed HttpApi/Protocol
  schemas and generated SDK files were not changed.
- Benchmark processes/listeners and provider renderers were closed. No benchmark
  service remains running. Only worktree dependencies/build artifacts, small
  frozen bundles and durable logs remain; no credentials/raw logs/native binaries
  are committed. Global `oc`, other worktrees, their installed binaries/processes
  and the immutable coordinator baseline were left untouched under the experiment
  rules. No global deployment was performed.

**Remaining limitation:** authoritative reconnect/hydration is not implemented or
claimed. This prevents default bounded server SSE, not default lossless client
batching. The previously rejected recovery prototype has been withdrawn rather
than used to paper over missing state owners/cursor fencing.

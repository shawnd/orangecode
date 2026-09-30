# EVENTS experiment (experimental; not ready for default enablement)

## Hypothesis and implementation

Selective transcript delivery before each subscriber queue and JSON serialization removes unrelated-session parser/store multiplication. Countermetrics are elapsed time, CPU, retained transcript bytes, delivered counts/bytes, and whole-probe PSS. Global summaries (including cost), status and pending permission/question events remain unfiltered. Interest grants no authority.

`/global/event?sessions=<comma-separated IDs>` is opt-in; omitted query retains legacy delivery, empty query receives metadata only. IDs include descendants seeded from the database and subsequently observed creation events. Filtering occurs inside the bus callback before `Queue.offerUnsafe`. `server.connected` now follows listener installation and seeding. No queue budget or disconnect cancellation policy was added.

TUI bounded interest is experimental: `OPENCODE_EXPERIMENTAL_EVENT_INTEREST=1`. It includes the selected session and locally controlled active roots/descendants, prunes departed transcript stores, and waits for SSE readiness before navigation hydration. Automatic legacy approval now requires explicit local submission ownership independently of subscriptions. Merely navigating to another root does not authorize automatic approval. Ownership survives idle transcript release.

Integration touchpoints: global handler/group, new isolated `server/event-interest.ts`, TUI SDK/sync/data contexts, prompt submission, SDK generator compatibility patch. QUEUES must retain the filter before its queue offer and the connected readiness ordering. The legacy SDK generator preserves existing `global.event(options)` callers when adding the optional query argument. The follow-up also adds an optional `sequence` to the public `/api/session/:sessionID/message` snapshot and optional seeded ancestry to `server.connected`; both SDK generators were rerun.

## Provenance and measurements

Baseline commit: `8998bdb660d66c31a6e390c1195867b6c303c781`. Baseline source was measured before implementation, with only `eventResponse` exported for the probe. The frozen native binary was not used in these mechanism measurements. Its supplied reference is `/tmp/opencode/shared-server-base-bin/opencode`, version `0.0.0-shared-server-202609301000`, SHA256 `9a789076b6e7dda31664a058604a2aa2b8c26f629ce533e8f2d2ddae79e3a2ee`.

Three sequential baseline repeats followed by three changed repeats; arm order was not alternated. Raw JSON: `/tmp/opencode/events-baseline-{1,2,3}.json`, `/tmp/opencode/events-after-{1,2,3}.json`. Raw logs: `/home/shawn/.local/share/opencode/tool-output/tool_0f1c6c2df001wkgF3kFJPrtyTM` and `tool_0f1c8ee4f001qBXX6fH562Wy6x` in that directory.

| Metric               | Baseline median (range)   | Changed median (range)    |
| -------------------- | ------------------------- | ------------------------- |
| Events/client        | 14,546 (identical)        | 654 (identical)           |
| JSON bytes/client    | 10,824,355 (identical)    | 458,997 (identical)       |
| Retained text/client | 3,686,400 (identical)     | 153,600 (identical)       |
| CPU ms, whole probe  | 762.201 (735.033–779.294) | 202.455 (201.345–209.448) |
| Elapsed ms           | 512.390 (503.664–528.413) | 188.806 (188.726–196.119) |
| PSS KiB, whole probe | 384,214 (360,318–385,378) | 323,366 (297,402–325,198) |

Scope: actual production SSE serializer, generated SDK SSE parser, two actual SDKProvider/DataProvider TUI stores in one process. Synthetic emissions represent 24 concurrent legacy/V2 session streams across two directory labels, 300 × 512-byte deltas per stream. No model/provider spend, forced GC or user credentials. This supports the local mechanism (95.5% fewer events, 95.8% fewer JSON bytes, 95.8% less retained text, 73.4% less probe CPU). PSS is **not fleet PSS** and includes test/runtime overhead. Background catalog fixture responses produced warnings equally in both arms; the mock location path was corrected afterwards. No live durable provider runs or actual project fixtures were exercised by this probe.

Reproduce changed mechanism from `packages/opencode`:

```sh
flock /tmp/opencode/shared-server-bench.lock env EVENT_BENCH=after EVENT_BENCH_OUT=/tmp/opencode/events-after-repro.json bun test test/server/server-event-bench.test.tsx --timeout 120000
```

To reproduce the pre-change baseline, use the baseline commit plus the benchmark instrumentation/harness; simply setting EVENT_BENCH=baseline on the changed TUI is not a valid original-store baseline. The initial discarded probe had an initial subscription race and zero retained text; it was replaced by the three fully delivered baseline samples above.

## Verification and remaining prerequisites

- Offline frozen isolated dependency install passed; workspace resolution confirms Core and SDK resolve inside this worktree.
- `bun run generate` in Client and legacy SDK generator passed.
- Production SSE tests passed (2 tests/14 assertions): global metadata, descendant tasks/costs, sync envelopes, empty interests, rejection before JSON (throwing serialization getter never invoked), connected readiness and subscription cleanup.
- TUI ownership/navigation interest test passed: unrelated root/descendant cannot gain authority by viewing, locally submitted descendants can, navigation drops prior viewing interest, idle releases transcripts but preserves ownership, cycles terminate.
- The initial commit lacked a V2 snapshot/event watermark and database/authority integration coverage. The follow-up below addresses these at focused service/store level; complete active durable legacy/V2 fleet verification remains outstanding.
- Initial typechecks found SDK call-shape compatibility and test-layer database dependencies; both were corrected. Final locked checks (`tool_0f1cc420f001J1haRK7FwzqgnV` in the log directory above) passed 7 tests/21 assertions, and typecheck reports only known baseline `dialog-usage-stats.tsx:43` missing `sdk.globalClient`, intentionally unpatched. A worktree-local native build passed (`tool_0f1caa106001AgXmCd3csVbhqI`); final SDK compatibility regeneration happened afterwards, so rebuild before deployment.
- Native build remains worktree-local; no global deployment per common experiment rules. The follow-up native probe launches only its own isolated daemon and local fake provider, with cleanup in finalizers. User processes and other experiment worktrees remain untouched.

## Follow-up verification checkpoint

- The message API now reads the aggregate sequence and projected page in one database transaction. Selective V2 hydration buffers arrivals, replays newer durable commits, rejects stale/duplicate sequences, and cancels stale hydration when navigating away. Live-only deltas remain live; duplicate direct copies of durable events are skipped. Volatile fragments that predate a reconnect are not durable history and cannot be recovered until their full-value settlement boundary.
- Server readiness now carries database-seeded parent rows before buffered events are released. The client observes this ancestry before resolving readiness, preserving descendant interest and ownership after attachment without granting a second client authority.
- The TUI SDK registers ownership before legacy or V2 submission dispatch, supports explicit client-local `adoptSession`, and flushes batched arrivals before hydration snapshots are installed. Navigation, creation and hydration remain view-only. V2 automatic permission replies are ownership-gated as well as legacy replies.
- SDK compatibility generation now preserves first-argument options at runtime, including an explicit `client` override. A generated SDK consumer test verifies the outgoing URL and custom header.
- Locked Server tests: **9 passed, 0 failed, 29 assertions**. Includes real SQLite persisted descendant seeding, production SSE serializer/cleanup, generated SDK compatibility, global/control-plane routes. Log: `tool_0f1dd4af2001G3h8IcSM3G2JCY` in the log directory above.
- Locked TUI tests: **19 passed, 0 failed, 116 assertions** across `event-interest.test.tsx`, `session-interest.test.ts`, `data.test.tsx`, and existing `permission.test.tsx`. Includes two real SDKProvider/SyncProvider clients, negative navigation authority, positive explicit adoption, legacy/V2 submission ownership before dispatch, global unseen status/question visibility, legacy stale snapshot removals/updates, and V2 hydration/live-delta replay. These use controlled HTTP snapshots, not durable model execution. The fixture's missing optional KV file emitted nonfatal warnings. Log: `tool_0f1d9e7ca001IdQ17wR2EFv532`.
- Final generator-then-build pipeline passed generation, the 9 Server tests, and the native build/smoke test before attempting the separate native probe. Binary: `packages/opencode/dist/opencode-linux-x64/bin/opencode`, version `0.0.0-server-events-202609301031`, SHA256 `23fdbf86835db79377dccaadd82923c2bb48b6b85268fd6803d98ab4ffe58b71`. This is correctness provenance, not a performance sample.
- The compiled-daemon fake-provider probe initially failed before assertions. After correct daemon attachment and stderr diagnostics, both SSE streams connected and the prompt was admitted/promoted, but the daemon reported `SessionRunnerModel.ModelUnavailableError: local/fake` before making a provider request. Raw diagnostic: `tool_0f1e63dc500103lJm68nDIBHsU`. Waiting for the configured model to become available before prompt submission fixed the harness readiness race: the root permission/question/durable snapshot probe then **passed, 1 test/9 assertions** (`tool_0f1e7f2b8001OEfrHYf6qKbEhs`).
- Aborting the SDK stream also exposed an unhandled promise rejection from `reader.cancel()`. The legacy SDK generator now consumes that asynchronous cancellation rejection, and generated outputs were regenerated successfully (`tool_0f1e63dbd001aUCOJq6QrVXV6x`).
- Locked `packages/opencode` typecheck completed with **only the known baseline** `dialog-usage-stats.tsx:43` missing `sdk.globalClient`; the two new Session-ID narrowing errors are fixed. Raw log: `tool_0f1e44b40001N2XO4alPxIS0Kf`. The previous missing Schema-package import was replaced with the existing Core schema facade, preserving workspace dependencies without modifying the lockfile.
- After SDK cancellation regeneration, locked Server tests again passed **9 tests/29 assertions**, and OpenCode typecheck again reported only that baseline error (`tool_0f1e8aba40018hVrKP00GKq7n8`). `packages/server` typecheck **passed** (`tool_0f1e8bff8001mmRKtuaPyNN7Zn`). The expanded native harness also typechecked without new errors (`tool_0f1ebc5b8001g9WaVIoA6mfErz`).
- The latest worktree-local native build/smoke test **passed** (`tool_0f1e8f1bd0013Vrj73gr1U7K6C`): version `0.0.0-server-events-202609301042`, SHA256 `f41806c69e48369db1821b9b735cb75e9e1d7b8261fb2a603f29fbe19d5203a0`. The earlier binary above is superseded for final native comparisons.
- Prior committed checkpoint: `97e7a077c48e0c6d80a666e41f84ba1ddf29631c`. The verified follow-up is delivered as `fix(tui): reconcile selective event hydration`; its exact SHA is available in this branch's git log and the final handoff.
- The original measurement table remains the initial source-level filter/store mechanism experiment. It is not a remeasurement of the follow-up selective durable-hydration path. The separate native comparison below uses compiled daemons and SDK streams; additive full-TUI fleet PSS and final TUI-store performance remain outstanding.

Reproduce focused checks from the indicated package directories:

```sh
# packages/opencode
flock /tmp/opencode/shared-server-bench.lock bun test test/server/event-interest.test.ts test/server/httpapi-global.test.ts test/server/httpapi-control-plane.test.ts --timeout 30000
flock /tmp/opencode/shared-server-bench.lock bun typecheck
flock /tmp/opencode/shared-server-bench.lock env NATIVE_EVENT_BIN="$PWD/dist/opencode-linux-x64/bin/opencode" bun test test/server/native-event-interest.test.ts --timeout 60000
# packages/tui
flock /tmp/opencode/shared-server-bench.lock bun test test/cli/tui/event-interest.test.tsx test/session-interest.test.ts test/cli/tui/data.test.tsx test/cli/tui/permission.test.tsx --timeout 30000
```

Recommendation: **opt-in experiment only**. Mechanism is supported; realistic active durable legacy/V2 multi-project fleet measurement and the correctness prerequisites above are outstanding. This report deliberately does not claim the full requested fleet/correctness experiment is complete.

## Final frozen-native comparison

Three independent pairs completed under one shared lock, in order **baseline/after, after/baseline, baseline/after**. Every run launched a fresh isolated compiled daemon, the same local fake provider and the same generated SDK harness. HOME/XDG, explicit database filename, configuration and model readiness were matched. Startup/model discovery occurred before the timed phase. No forced GC or user credentials were used.

Workload: one project, a root with a bash permission request followed by a question and final text, one persisted descendant with a text turn, and one unrelated root with a text turn (**5 provider requests**). Three concurrent streams requested the root, empty interests, and legacy unfiltered delivery respectively. The public V2 create API has no parent field, so the harness explicitly seeds only the descendant's `parent_id` in the isolated database before subscription. Its actual provider run and projected messages execute through the native daemon. This verifies persisted descendant interest, not task-created descendant lifecycle.

All **6 native runs passed**, with **12 assertions per baseline run and 14 per changed run** (78 total): global pending permission/question visibility and external authoritative replies, durable projected output, changed snapshot sequence, seeded connected ancestry, descendant output retained, unrelated-root output excluded, metadata-only transcript exclusion, unchanged unfiltered witness, and daemon shutdown. Log: `/home/shawn/.local/share/opencode/tool-output/tool_0f1ed8b60001aBYy7pkWocQkqw`.

| Native metric                            | Frozen baseline median (range)  | Final changed median (range)    |
| ---------------------------------------- | ------------------------------- | ------------------------------- |
| Transcript events, root-interest stream  | 65 (identical)                  | 52 (identical)                  |
| Transcript events, empty-interest stream | 65 (identical)                  | 0 (identical)                   |
| Transcript events, legacy witness stream | 65 (identical)                  | 65 (identical)                  |
| Transcript events, all 3 streams         | 195 (identical)                 | 117 (identical)                 |
| Transcript JSON bytes, all 3 streams     | 84,285 (84,285–84,480)          | 51,089 (50,972–51,089)          |
| Timed workload elapsed ms                | 1,309.734 (1,216.725–2,180.249) | 1,280.004 (1,212.474–1,626.162) |
| SDK harness/provider CPU ms              | 55.759 (54.265–58.698)          | 53.035 (34.377–54.313)          |
| Post-run daemon + harness PSS KiB        | 781,035 (777,347–784,460)       | 744,033 (734,561–769,729)       |

Transcript counts support the native mechanism: **40.0% fewer transcript events and 39.4% fewer transcript JSON bytes** across all three streams, including the deliberately unchanged witness. Byte variation comes from generated envelope/fixture values. JSON byte counts exclude SSE framing and other metadata. Harness CPU excludes daemon CPU. PSS sums `/proc/<daemon>/smaps_rollup` and `/proc/<harness>/smaps_rollup` exactly once after the workload while streams remain attached; the local provider and all SDK clients live inside the harness process. Tool subprocesses have settled before that sample. This is a two-process post-run sample, **not active full-TUI fleet PSS**. The small elapsed/CPU changes and PSS medians are countermetrics, not robust general performance conclusions; the first pair had a materially wider timing range.

Raw samples: `/tmp/opencode/events-native-baseline-{1,2,3}.json` and `/tmp/opencode/events-native-after-{1,2,3}.json`. Each records binary SHA256, per-stream counts/JSON bytes, timing, harness CPU and per-process PSS. Baseline SHA256 is `9a789076b6e7dda31664a058604a2aa2b8c26f629ce533e8f2d2ddae79e3a2ee`; final changed SHA256 is `f41806c69e48369db1821b9b735cb75e9e1d7b8261fb2a603f29fbe19d5203a0` (versions and paths above). The two earlier expanded-fixture attempts failed before provider work because of a channel-specific database path and incomplete SQLite open flags; neither produced a performance sample. Their logs are `tool_0f1eb68c6001uVrWoL8GxEv8NI` and `tool_0f1ec973b001gFa26PGtALWXZ9`.

Reproduce from `packages/opencode` using the frozen artifacts above, then repeat with pair order reversed:

```sh
flock /tmp/opencode/shared-server-bench.lock env NATIVE_EVENT_BIN=/tmp/opencode/shared-server-base-bin/opencode NATIVE_EVENT_BASELINE=1 NATIVE_EVENT_OUT=/tmp/opencode/events-native-baseline-repro.json bun test test/server/native-event-interest.test.ts --timeout 60000
flock /tmp/opencode/shared-server-bench.lock env NATIVE_EVENT_BIN="$PWD/dist/opencode-linux-x64/bin/opencode" NATIVE_EVENT_OUT=/tmp/opencode/events-native-after-repro.json bun test test/server/native-event-interest.test.ts --timeout 60000
```

Remaining default-enablement prerequisites: real full-TUI active legacy/V2 multi-project clients with final hydration/store performance, task-created descendant lifecycle, navigation/reconnect races against live durable execution, full fleet CPU/PSS and cancellation/tail-latency measurements. Legacy snapshots still lack an atomic watermark, and pre-reconnect volatile fragments require later durable settlement to recover. Keep the experiment opt-in.

Final OpenCode typecheck after the native harness changes again reports **only the known baseline** `sdk.globalClient` error (`tool_0f1ee6b8d001Ad8ami9HJQLhQv`). Final whitespace/diff checks passed. Every completed native run stopped its isolated daemon, provider and streams and removed its temporary fixture; all queued EVENTS jobs completed. Native artifacts stay worktree-local under the experiment rules.

# EVENTS experiment (experimental; not ready for default enablement)

## Hypothesis and implementation

Selective transcript delivery before each subscriber queue and JSON serialization removes unrelated-session parser/store multiplication. Countermetrics are elapsed time, CPU, retained transcript bytes, delivered counts/bytes, and whole-probe PSS. Global summaries (including cost), status and pending permission/question events remain unfiltered. Interest grants no authority.

`/global/event?sessions=<comma-separated IDs>` is opt-in; omitted query retains legacy delivery, empty query receives metadata only. IDs include descendants seeded from the database and subsequently observed creation events. Filtering occurs inside the bus callback before `Queue.offerUnsafe`. `server.connected` now follows listener installation and seeding. No queue budget or disconnect cancellation policy was added.

TUI bounded interest is experimental: `OPENCODE_EXPERIMENTAL_EVENT_INTEREST=1`. It includes the selected session and locally controlled active roots/descendants, prunes departed transcript stores, and waits for SSE readiness before navigation hydration. Automatic legacy approval now requires explicit local submission ownership independently of subscriptions. Merely navigating to another root does not authorize automatic approval. Ownership survives idle transcript release.

Integration touchpoints: global handler/group, new isolated `server/event-interest.ts`, TUI SDK/sync/data contexts, prompt submission, SDK generator compatibility patch. QUEUES must retain the filter before its queue offer and the connected readiness ordering. The legacy SDK generator preserves existing `global.event(options)` callers when adding the optional query argument. Client generator ran successfully; its current public `/api` surface did not change.

## Provenance and measurements

Baseline commit: `8998bdb660d66c31a6e390c1195867b6c303c781`. Baseline source was measured before implementation, with only `eventResponse` exported for the probe. The frozen native binary was not used in these mechanism measurements. Its supplied reference is `/tmp/opencode/shared-server-base-bin/opencode`, version `0.0.0-shared-server-202609301000`, SHA256 `9a789076b6e7dda31664a058604a2aa2b8c26f629ce533e8f2d2ddae79e3a2ee`.

Three sequential baseline repeats followed by three changed repeats; arm order was not alternated. Raw JSON: `/tmp/opencode/events-baseline-{1,2,3}.json`, `/tmp/opencode/events-after-{1,2,3}.json`. Raw logs: `/home/shawn/.local/share/opencode/tool-output/tool_0f1c6c2df001wkgF3kFJPrtyTM` and `tool_0f1c8ee4f001qBXX6fH562Wy6x` in that directory.

| Metric | Baseline median (range) | Changed median (range) |
| --- | --- | --- |
| Events/client | 14,546 (identical) | 654 (identical) |
| JSON bytes/client | 10,824,355 (identical) | 458,997 (identical) |
| Retained text/client | 3,686,400 (identical) | 153,600 (identical) |
| CPU ms, whole probe | 762.201 (735.033–779.294) | 202.455 (201.345–209.448) |
| Elapsed ms | 512.390 (503.664–528.413) | 188.806 (188.726–196.119) |
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
- Full actual navigation/hydration under live arrivals, initial V2 snapshot races, database-seeded descendants, and real permission/question reply negative-authority integration tests are still required. V2 message refresh still lacks a snapshot/event watermark; do not enable by default until this is settled.
- Initial typechecks found SDK call-shape compatibility and test-layer database dependencies; both were corrected. Final locked checks (`tool_0f1cc420f001J1haRK7FwzqgnV` in the log directory above) passed 7 tests/21 assertions, and typecheck reports only known baseline `dialog-usage-stats.tsx:43` missing `sdk.globalClient`, intentionally unpatched. A worktree-local native build passed (`tool_0f1caa106001AgXmCd3csVbhqI`); final SDK compatibility regeneration happened afterwards, so rebuild before deployment.
- Native build remains worktree-local; no global deployment per common experiment rules. No fixture servers or user processes were launched or changed.

Recommendation: **opt-in experiment only**. Mechanism is supported; realistic active durable legacy/V2 multi-project fleet measurement and the correctness prerequisites above are outstanding. This report deliberately does not claim the full requested fleet/correctness experiment is complete.

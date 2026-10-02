# Shared-server follow-up audit

## Scope and verification

Four parallel audits reviewed daemon lifecycle, event delivery/recovery, session
execution/resources, and configuration/security. The comparison was current
`shawnd` (`7bd0148203fb641f3413ca9fac13e5bab1bcd75c`) to shared-server HEAD
`f9f587ec24988f619dcec2beb023f162483a02bb`. Production changes end at merge
`7e57e73e42d5eeff5ba731dc1eb04adbf6314925`; at audit time, pending changes were
benchmark scripts and reports. No production fixes were made during the audit.

Findings below are verified source paths and source-derived failure schedules,
not executed end-to-end reproductions. Two small Effect probes exercised the
actual background registry and race semantics; their narrower scope is documented
below. No fresh package suites, process reproductions, or exploit tests were run.
No Critical finding was established.

Paths are relative to this worktree. High findings deserve first attention, but
explicit opt-in and environment requirements remain part of their scope.

## Follow-up remediation

All seven independently owned remediation areas have been implemented, handed
off, and reviewed together. Focused regressions, affected package typechecks,
and compiled MINI/full-TUI correctness flows pass. The findings below retain
the original audited failure schedules; current remediation evidence is here.

| Area                                                              | Findings assigned                                   |
| ----------------------------------------------------------------- | --------------------------------------------------- |
| Daemon transport, shutdown, discovery, and reuse policy           | H1, H2, H3, H4, M1, M7                              |
| Client reconnect, hydration, and project-local MCP status         | H5, H6, M3, M4, M5; deferred MCP status integration |
| Bounded event subscription during ancestry seeding                | M6                                                  |
| Archived background output, cancellation, and foreground failures | H7, M2                                              |
| UI proxy and split-pane credential boundaries                     | M8, M9                                              |
| Location-scoped pending MCP OAuth flows                           | M10                                                 |
| Explicit-worker startup and RPC failure handling                  | M11                                                 |

The stopped architecture benchmark and its frozen comparator artifacts remain
separate evidence. No performance measurements were restarted, and the installed
global commands were not replaced.

### Focused regression evidence

- **H1/H2/H3/H4/M1/M7:** Reviewed Unix timeout configuration, concurrent bounded
  cleanup, owned discovery ancestry/metadata/local-endpoint validation, nonce
  proof before credential-bearing reuse, effective backend restriction/database
  identity, and stopping-endpoint fencing. Explicit daemon directories also
  reject incompatible backend policies/databases. Compatible builds and purely
  client-side presentation/state differences can still reuse a backend.
  Tests execute real daemon requests beyond ten seconds and idle heartbeats,
  stuck initialization plus independent process cleanup, forged/rebound endpoints,
  and real disk-database reuse/mismatch cases. The final parent five-file suite
  passed **23 tests, 251 assertions, 0 failures** in 77.69 seconds. Evidence:
  `/home/shawn/.local/share/opencode/tool-output/tool_0faad5da7001ehJbMmu0V3sBDF`.
- **H5/H6/M3/M4/M5 and project-local MCP status:** Reviewed stream/recovery
  readiness separation, replacement/EOF epochs, authoritative approvals/questions/
  status before submission, abort-before-dispatch, fresh epoch-fenced hydration,
  volatile transcript preservation, and legacy touched info/todo/diff protection.
  MCP status/resources/actions are reconciled with the current project. The tests
  use actual SDK HTTP/SSE recovery, stalled/late hydration, disconnects and
  reconnects, pending requests, and project-local state. The parent eleven-file
  suite passed **51 tests, 215 assertions, 0 failures**. Evidence:
  `/home/shawn/.local/share/opencode/tool-output/tool_0faad5d950015htBtk6m3gfx4H`.
  After adding the final optional-location guard, the focused recovery/data suites
  passed **21 tests, 89 assertions, 0 failures** alongside the TUI typecheck:
  `/home/shawn/.local/share/opencode/tool-output/tool_0faae5d2b0015ylQE3OIqmKJU6`.
- **M6:** Reviewed the bounded-buffer and global SSE changes. Subscription
  acquisition runs in a scoped fiber so a blocked ancestry seed cannot gate
  terminal delivery. Overflow and consumer cancellation close admission and
  release the listener/timer; late acquisition is reconciled with teardown.
  Lossless default and exact `bounded-v1` opt-in remain unchanged.
  From `packages/opencode`,
  `TMPDIR=/home/shawn/code/opencode-server-bench-results/fix-buffer-tmp flock /tmp/opencode/shared-server-bench.lock bun test test/server/event-buffer.test.ts test/server/httpapi-global.test.ts test/server/event-interest.test.ts`
  passed **25 tests, 90 assertions, 0 failures**. Evidence:
  `/home/shawn/.local/share/opencode/tool-output/tool_0f33d5f3f001eZJ2U4KY8616MM`.
  Integrated package/native verification is recorded below.
- **H7/M2:** Reviewed descriptor-only background-job listing and explicit
  archived-output availability/expiry. Missing or unreadable historical tails
  retain terminal status without blocking unrelated cancellation. Foreground
  shell races now propagate the first failure; output draining and sink errors
  remain covered by abort/timeout guards and process-group cleanup. Tests use
  actual deleted/cleaned-up/unreadable tails, legacy cancellation in separate
  sessions/Locations, real sink failures, and descendant-held pipes.
  Under the shared lock with disk-backed `fix-jobs-tmp`,
  `bun test test/background-job.test.ts` from `packages/core` passed **6 tests,
  421 assertions**; `bun test test/tool/background-shell.test.ts test/tool/shell.test.ts`
  from `packages/opencode` passed **47 tests, 176 assertions**;
  `bun test test/session/prompt.test.ts -t 'cancel|interrupt'` passed **15 tests,
  66 assertions** with 52 filtered. All three had zero failures. Evidence:
  `/home/shawn/.local/share/opencode/tool-output/tool_0f33f31d5001PILamm61TYCB9q`,
  `/home/shawn/.local/share/opencode/tool-output/tool_0f3487dd0001XSgVqK9wp1GJOj`,
  `/home/shawn/.local/share/opencode/tool-output/tool_0f33f31f7001L7W30b4Wb6HJ1Q`.
  Parent Core typechecking caught an `Exit.hasInterrupts` type-guard narrowing
  issue; inspecting `Cause.hasInterrupts(exit.cause)` preserves the intended
  interrupt behavior without narrowing the failure branch to `never`. Core
  `bun typecheck` and all six background-job tests then passed together:
  `/home/shawn/.local/share/opencode/tool-output/tool_0f34ed0ed001UXeBhESvkvExH1`.
  Integrated package/native verification is recorded below.
- **M8/M9:** Reviewed UI-specific removal of local `Authorization` before
  hosted-UI dispatch and authenticated Herdr splitting through its private
  JSON-line Unix socket API. Split credentials enter the pane environment
  without subprocess-argv exposure; socket ownership, permissions, ancestry,
  response framing, and failure cleanup are checked. Generic API proxies still
  preserve legitimate authorization.
  Under the shared lock with disk-backed `fix-credentials-tmp`:
  `bun test src/util/herdr.test.ts --timeout 30000` from `packages/tui` passed
  **13 tests, 78 assertions**;
  `bun test test/server/proxy-util.test.ts test/server/httpapi-ui.test.ts test/cli/tui/attach.test.ts --timeout 30000`
  from `packages/opencode` passed **27 tests, 65 assertions**. The final updated
  attach suite passed **2 tests, 7 assertions**, bringing this area to **41 unique
  passing tests**. Evidence:
  `/home/shawn/.local/share/opencode/tool-output/tool_0f3458d20001Etk6fjYCZqazq8`,
  `/home/shawn/.local/share/opencode/tool-output/tool_0f3458d25001BHBmAq1zou7gz4`,
  `/home/shawn/.local/share/opencode/tool-output/tool_0f3496ece001wDMYec4u04lmUQ`.
  Authenticated Windows splitting fails closed until a confidential named-pipe
  transport with validated ACLs is available. Integrated package/native
  verification is recorded below.
- **M10:** Reviewed Location/Effect-layer/workspace ownership of pending OAuth
  flows, provider-local state and PKCE, flow-state callback cancellation, and
  URL-aware credential updates/removal. Real local OAuth authorities validate
  independent overlapping same-name flows and reject foreign authorization
  codes. Durable user credential sharing is retained.
  From `packages/opencode`,
  `flock /tmp/opencode/shared-server-bench.lock env TMPDIR=/home/shawn/code/opencode-server-bench-results/fix-mcp-tmp bun test test/mcp test/server/httpapi-mcp.test.ts test/server/httpapi-mcp-oauth.test.ts test/tool/mcp-manage.test.ts test/cli/mcp-add.test.ts`
  passed **92 tests, 336 assertions, 0 failures across 16 files**. Evidence:
  `/home/shawn/.local/share/opencode/tool-output/tool_0f3449b230019ZqUTxA1UnbyjD`.
  Parent typechecking also caught a reconnect error leaking into the public
  `NotFoundError` contract. OAuth reconnect failures now return failed status;
  interruption/defects retain their own semantics. An added real-authority test
  exchanges a token, forces reconnect HTTP 503, and verifies failed status,
  callback/pending-flow cleanup, and replay rejection. The parent OAuth/API
  regression suites passed **21 tests, 135 assertions, 0 failures**. Evidence:
  `/home/shawn/.local/share/opencode/tool-output/tool_0faad5d87001YE5lolud5CJiXD`.
- **M11:** Reviewed serialized RPC failures, pending-call rejection on actual
  Worker error/close, listener disposal, bounded startup, and idempotent awaited
  worker shutdown. Real-worker tests cover occupied/invalid ports, stuck startup,
  natural child exit, listener rebind, and event subscription/unsubscription.
  From `packages/opencode`,
  `flock /tmp/opencode/shared-server-bench.lock env TMPDIR=/home/shawn/code/opencode-server-bench-results/fix-rpc-tmp bun test --timeout 15000 test/util/rpc.test.ts test/cli/tui-shutdown.test.ts`
  passed **12 tests, 60 assertions, 0 failures**. Evidence:
  `/home/shawn/.local/share/opencode/tool-output/tool_0f342b733001OZxaZ3WKM9XnN1`.
  Final RPC-only verification passed **7 tests, 42 assertions, 0 failures**:
  `/home/shawn/.local/share/opencode/tool-output/tool_0f3435056001Lme9iJVtuZ84Wo`.
  Integrated package/native verification is recorded below.

### Diff coverage review follow-up

The subsequent request to verify adequate tests reviewed the full remediation
diff against behavioral regressions, including failure and cleanup paths. Added
coverage exercises failed HTTP 503 recovery followed by a fresh authoritative
snapshot, volatile reasoning/tool-input preservation and settlement, concurrent
same-Location OAuth flow replacement, oversized Herdr responses, and oversized
daemon metadata rejection before any credential-bearing request.

The output-capture fix also needed backpressure coverage. Real producers writing
4 MiB without a stdout consumer reproduced scope teardown hanging. Termination
now closes unread OS output pipes, gives captured readers EOF, and waits for the
owned Unix process group so a reaped leader cannot cancel escalation while a
TERM-ignoring descendant survives. Regressions cover both scope teardown and
explicit kill; existing actual descendant cancellation tests also pass.

The stubborn-process regression now waits for its SIGTERM handler to be installed
before requesting termination. That barrier exposed the test's use of a frozen
TestClock, not another production defect: the escalation timer could not advance.
The backpressure and stubborn-process cases now use the live test layer, retaining
the readiness barrier, process-disappearance checks, and timing assertions.

Final focused coverage is **330 unique tests across 45 files, 1,767 assertions,
zero failures**. Core, TUI, and OpenCode typechecks also passed after the runtime
changes; earlier Server and sdk-next typechecks remain applicable.

| Coverage group                                                       | Tests | Assertions | Files |
| -------------------------------------------------------------------- | ----: | ---------: | ----: |
| Core process spawning and background registry                        |    33 |        453 |     2 |
| TUI recovery, hydration, batching, shutdown, interests, and Herdr    |    68 |        310 |    12 |
| Shell/background cancellation and Worker/RPC lifecycle               |    59 |        236 |     4 |
| MCP lifecycle, OAuth ownership, HTTP APIs, management, and CLI       |    94 |        356 |    16 |
| Daemon identity/policy/shutdown, SSE buffering, UI proxy, and attach |    76 |        412 |    11 |

Commands ran from their package directories under the shared lock and disk-backed
TMPDIRs. The final Core run was `bun typecheck && bun test
test/effect/cross-spawn-spawner.test.ts test/background-job.test.ts` and passed
33 tests/453 assertions in 978 ms after the live-clock correction. The four other
group logs are under `/home/shawn/.local/share/opencode/tool-output/`:

- TUI: `tool_0fad72ab2001wI4J1CMq33C4EO` (the logged HTTP 503 is deliberately
  injected by the successful recovery-retry regression).
- Shell/Worker/RPC: `tool_0fad72ade001snQMtyaTi8RqrP`.
- MCP: `tool_0fad72aea00114z6vaZX0gvux8`.
- Daemon/SSE/UI/attach: `tool_0fad72af6001ADj4O4W2RT30Pb`.

This is adequate focused behavioral coverage for the remediated Linux paths,
not a whole-repository or cross-platform suite claim. Confidential authenticated
Windows split transport remains deliberately unavailable. The full TUI's deferred
bounded-stream recovery and client-close/whole-Location ownership policies are
outside this diff's implementation scope. Stopped benchmark measurements are
historical evidence, not newly revalidated performance claims.

### Integrated typechecks and compiled correctness

`bun typecheck` passed from the affected package directories: **Core, Server,
sdk-next, OpenCode, and TUI**. Parent corrections address Core failure-branch
narrowing, Bun's Unix listener option typing while retaining `idleTimeout: 0`,
OAuth reconnect status/error-contract consistency, optional event Location and
Session-ID narrowing, and required fixture event fields. No public Protocol or
HttpApi schema changes were required.

Typecheck evidence:

- Core: `tool_0f34ed0ed001UXeBhESvkvExH1` (also six background-job tests).
- Server: `tool_0f3505995001iCgeNtu4TG255D`.
- sdk-next: `tool_0f3518c5b001IO87GQZ3xcYXK4`.
- OpenCode: `tool_0faae5d220014EIj5Xu8626F2e`.
- TUI: `tool_0faae5d2b0015ylQE3OIqmKJU6` (also focused recovery/data tests).

The compiled background-job cycle subsequently found a short-lived-output race
in the process spawner: a child could exit and flush unread stdout/stderr before
an Effect consumer subscribed. A regression awaiting real process exit before
reading both streams reproduced empty output. Capturing the pipes immediately
into bounded `PassThrough` streams now preserves output and backpressure, with
buffers destroyed at process-scope finalization. The regression uses an immediate
producer, without delaying it to hide the race. After this correction:

- Core typecheck plus process-spawner/background-job suites passed **31 tests,
  448 assertions, 0 failures**: `tool_0fab8afd8001cbwVI6oRKkCQh7`.
- OpenCode typecheck plus both shell suites passed **47 tests, 176 assertions,
  0 failures**: `tool_0fab8afde001rvLVIHEaEmtv1T`.

These log names are under `/home/shawn/.local/share/opencode/tool-output/`.
Five initial reruns exited before checks because their shared lock directory had
disappeared. Restoring the same private lock directory resolved that environmental
failure; those exit-66 attempts are not counted as test results.

The worktree-local native build passed using
`bun run script/build.ts --single --skip-install --skip-embed-web-ui` under the
shared lock, with disk-backed temporary files. The new artifact is frozen at
`/home/shawn/code/opencode-server-bench-results/artifacts/shared-server-fixed2/opencode`:

- Version: `0.0.0-shared-server-fixed2-20261001`.
- SHA-256: `f7bb176c2a796a73d276d7e7c706ba572846d82c5c7acaefd4f9c608080fa554`.
- Artifact hash matches the worktree build; `--version` and native embedding
  build smoke passed. Provenance is alongside the artifact.
- Build log: `tool_0fab9341f001zfQpjItsGCKsvW`.
- The earlier fixed artifact is retained separately as intermediate evidence.

Real compiled PTY/provider correctness flows passed for **MINI and full TUI**
with resource policies enabled. Both exercised an actual permission-footer
approval, completed shell output, transcript replay after resume, forked history
without changing the original, headless attach, and headless local execution.
The resource-policy checks also indexed a real search fixture, crossed its idle
retirement boundary, and reopened it. Results:

- `/home/shawn/code/opencode-server-bench-results/af-mini2/result.json`.
- `/home/shawn/code/opencode-server-bench-results/af-full3/result.json`.

The first full-TUI run exposed a harness race: first paint preceded asynchronous
fork completion. The harness now waits for the fork count before retaining the
same exact-count/original-history/fork-replay assertions; the corrected run passed.
These are correctness flows with a prestarted daemon, not startup or memory
benchmarks.

A separate real compiled-binary cycle also passed on the final artifact:
`/home/shawn/code/opencode-server-bench-results/af-job3/result.json`, with the
fixture source in `native-job-cycle.py` alongside that evidence root. It launched
an immediate background producer, observed persisted output and its archived
descriptor, and checked the exact output marker. It then launched a live job in
another Session, deleted only the fixture's historical archived tail, and verified
the historical job retained **completed status and exit 0** with **expired output**
(missing payloads are expired; unreadable payloads are unavailable). Aborting the
live Session still produced a cancelled descriptor and removed the original
PID/start-time process identity. All fixtures stop their owned daemon in finalizers.

Final cleanup checks found no processes at the final three fixture daemon PIDs
(`402855`, `404891`, `413962`) and no retained `af-*/daemon/server.json` discovery
metadata. Scoped formatting checks and `git diff --check` passed. The original
`shawnd` and pre-fix shared-server comparator SHA-256 hashes still match their
recorded frozen values. The architecture benchmark remains stopped.

#### Final coverage-review artifact

After the backpressured-output teardown correction, a separately frozen build
verified the current runtime diff:

- Artifact: `/home/shawn/code/opencode-server-bench-results/artifacts/shared-server-fixed3/opencode`.
- Version: `0.0.0-shared-server-fixed3-20261001`.
- SHA-256: `b267d842ecb8d9a2491519381db897ce6947539367bb754520e6a0d68c0aec1d`.
- Build/version smoke and artifact-versus-dist hash checks passed. Build evidence:
  `tool_0fadc9fef001C8ZCbQ1Mx6oEBH`.
- MINI resource-policy PTY flow: `af-mini3/result.json`, log
  `tool_0fadd73ce0010D2hXCH4kEkWe8`.
- Full-TUI resource-policy PTY flow: `af-full4/result.json`, log
  `tool_0fadd73db001IkxOqL1OKVoDu0`.
- Actual background output-release/expired-tail/cross-session cancellation cycle:
  `af-job4/result.json`, log `tool_0fadd73e1001veBW37gbk3710e`.

All three correctness flows passed on that same hash. Paths beginning `af-` are
under `/home/shawn/code/opencode-server-bench-results/`. Owned daemon PIDs
696070, 698556, and 698090 are gone, as is the previously cleaned-up regression
descendant 613662; no `af-*/daemon/server.json` discovery files remain. The two
original comparator hashes and fixed2 hash were rechecked unchanged. Four Python
harness/summary scripts passed syntax validation without running benchmarks.

### Current inbound-merge coverage audit

This review used **`/home/shawn/code/opencode-shared-server`**, with remediation
commit `763303faef` and the staged, uncommitted merge of `shawnd`
`1fa5a03b5f9b92836bd8e9253b4af9d3c3f93927`. It inspected `git diff shawnd`
(129 files), the remediation commit, and the incoming merge resolutions. The
default `/home/shawn/code/opencode` checkout is not evidence for this diff.
The fixed3 artifact and all native results above are **pre-merge** evidence.

The existing tests assert behavior rather than merely counting completions:

| Boundary                                            | Behavioral evidence and current-merge verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FFF executor and search lifetime                    | Actual native direct/worker parity, bounded worker budgets, independent Location indexes/watchers, queued cancellation/fairness, failed-worker replacement, disposal acknowledgement, bounded admission and fallback to real ripgrep. Leases fence teardown/reopening and preserve a drain, descendant jobs, a detached/reattached PTY, and pending approvals. **59 tests / 589 assertions / 3 files pass.**                                                                                                                                                                    |
| Process capture, group termination, shell liveness  | Parent post-merge suites retain short-lived stdout/stderr, real backpressured producers, TERM-ignoring descendants, immediate sink/metadata failures, timeout/abort during output drain, orphaned-PID cleanup, expired archived tails, and cross-session cancellation. The combined liveness/output-join merge resolution is exercised by the real descendant-held-pipe regression. Parent Core **42 / 524 / 5** and OpenCode **212 / 1,056 / 10** pass.                                                                                                                        |
| Daemon discovery, policy and CLI setup              | Real concurrent clients, forged/rebound discovery, restrictive later policy, effective database identity, stopping fences, >10-second requests/heartbeats, and stuck-project shutdown cleanup. CLI/run tests also exercise source subprocess admission, exact JSON records, permissions, attach file contents, unknown-model failures, SIGINT, MINI transport/bootstrap/queue behavior, and argv dispatch. The 28-file run initially passed **230 tests**, skipped **5**, and found **2 failures**; the affected two-file rerun passes **19 / 74** after the corrections below. |
| Event filtering and bounded delivery                | Persisted descendant ancestry, metadata visibility, transcript rejection before JSON serialization, exact bounded-v1 negotiation, ordered immutable prefixes, explicit overflow terminal frames, blocked seed teardown, cancellation/late acquisition and listener cleanup. **52 / 154 / 6** pass.                                                                                                                                                                                                                                                                              |
| TUI hydration and merge resolutions                 | Parent **215 / 1,179 / 23** pass. Existing tests cover actual HTTP/SSE EOF/replacement, held old snapshots, authoritative approvals/status before submission, abort-before-POST, volatile fragments/full-value settlement, and ownership independently of navigation. Added tests cover history rendering with sidebars still held, supplied metadata versus live updates, and old sidebar replies arriving after fresh reconnect hydration in both default and selective modes. Updated focused suites **26 / 110 / 2** pass.                                                  |
| Public message snapshot and embedded host isolation | Added real-router/database regression reads message pages concurrently with 32 durable agent switches, checks every page's sequence against its exact projected prefix, and verifies an older paginated page carries the current aggregate fence. Existing embedded host notification isolation and live global events remain covered. sdk-next **6 / 92 / 2** pass.                                                                                                                                                                                                            |
| MCP ownership and credentials                       | Current-merge MCP suite **94 / 356 / 16** passes, including actual same-name concurrent OAuth flows, replacement/cancellation, foreign-code rejection, PKCE and reconnect-503 cleanup. Current event/UI suite includes local-Authorization stripping with generic proxy authorization retained. Parent Herdr tests retain private-socket credential transfer and the incoming fork-on-split assertions.                                                                                                                                                                         |
| Explicit worker/RPC and attach cleanup              | Real workers fail on occupied/invalid ports, time out stuck startup, reject pending RPCs, dispose subscriptions, exit naturally and release listeners for rebinding. Combined RPC/shutdown/attach suite **16 / 71 / 3** passes. The validation regression additionally checks that an invalid Session leaves legacy TUI config unmigrated; its latest standalone rerun is recorded separately.                                                                                                                                                                                  |

Two failures from expanded checks were actionable:

1. `run --format json` could emit two error records for one rejected prompt,
   depending on the HTTP-response/SSE ordering. `cli/cmd/run.ts` now reconciles
   these two failure reports while retaining distinct stream errors during a
   successful request. The existing real CLI unknown-model regression reproduced
   the duplicate and passes after the fix. The other CLI failure was a stale
   fallback-newline expectation: incoming `shawnd` intentionally removed
   `ctrl+return`; the test now asserts the current explicit binding.
2. sdk-next's per-test Flag mutation could not change `Database.node`'s filename
   captured at module evaluation. Deleting the first Location fixture left later
   tests opening a removed directory (`SQLITE_CANTOPEN`). The suite now retains
   one private database fixture until all embedded hosts are disposed; each test
   still uses its own Location directory and unique Session identity.

Client's current-merge typecheck and complete four-file suite pass **18 tests,
79 assertions** (`tool_0fb661fe8001M7LI72CdUAMSDf`), covering Promise/Effect
contracts, activity projection, event decoding and import boundaries. Server's
current-merge typecheck also passes (`tool_0fb661ff2001EXCssXXiKPTyOG`). Both used
`fix-events-tmp` under the same lock. This review did not regenerate either client.

An independent review subsequently identified a P2 deleted-Session recovery
defect; its reproduction, correction and verification are recorded below.
The concurrency snapshot test exercises real concurrent requests and storage;
it does not claim deterministic injection of every possible SQLite interleaving.

All commands below ran from the indicated package directory, prefixed with
`flock /tmp/opencode/shared-server-bench.lock env TMPDIR=...`. TMPDIRs are existing
disk-backed directories under `/home/shawn/code/opencode-server-bench-results/`.
Log names are under `/home/shawn/.local/share/opencode/tool-output/`.

| Package / TMPDIR suffix     | Command after the lock/environment prefix                                                                                                                                                                                                 | Log                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Core / `fix-jobs-tmp`       | `bun test --timeout 35000 test/filesystem/fff-worker.test.ts test/filesystem/search.test.ts test/filesystem/search-lifetime.test.ts`                                                                                                      | `tool_0fb5ee1c1001hpYgmWnodI3l1L`                                                                      |
| OpenCode / `fix-buffer-tmp` | `bun test --timeout 15000 test/server/event-buffer.test.ts test/server/event-interest.test.ts test/server/httpapi-global.test.ts test/server/httpapi-control-plane.test.ts test/server/httpapi-ui.test.ts test/server/proxy-util.test.ts` | `tool_0fb5ee1c6001WvYhxaadjvDSXn`                                                                      |
| OpenCode / `fix-daemon-tmp` | `bun test --timeout 45000 test/cli/daemon.test.ts test/cli/daemon-security.test.ts test/cli/daemon-search-profile.test.ts test/cli/daemon-policy-profile.test.ts test/project/instance.test.ts test/cli/entry.test.ts test/cli/run`       | `tool_0fb5ee1ca0017VEjhc3wsw7BON` (two failures corrected below; five preexisting direct-footer skips) |
| TUI / `fix-events-tmp`      | `bun typecheck && bun test --timeout 15000 test/cli/tui/event-recovery.test.tsx test/cli/cmd/tui/sync-live-hydration.test.tsx`                                                                                                            | `tool_0fb62ec07001V6i53lyxeKdayp`                                                                      |
| sdk-next / `fix-events-tmp` | `bun typecheck && bun test --timeout 15000`                                                                                                                                                                                               | `tool_0fb62ec11001AaDk5nGSZempX7`                                                                      |
| OpenCode / `fix-daemon-tmp` | `bun typecheck && bun test --timeout 45000 test/cli/run/run-process.test.ts test/cli/run/runtime.boot.test.ts`                                                                                                                            | `tool_0fb62ec450012LgSVEy30kxE39`                                                                      |
| OpenCode / `fix-mcp-tmp`    | `bun test --timeout 15000 test/mcp test/server/httpapi-mcp.test.ts test/server/httpapi-mcp-oauth.test.ts test/tool/mcp-manage.test.ts test/cli/mcp-add.test.ts`                                                                           | `tool_0fb6153750016yUGydbjqQoajE`                                                                      |
| OpenCode / `fix-rpc-tmp`    | `bun test --timeout 15000 test/cli/tui-shutdown.test.ts test/util/rpc.test.ts test/cli/tui/attach.test.ts`                                                                                                                                | `tool_0fb639b8c001wnxr0fAElRgMAC`                                                                      |

Parent post-merge Core/TUI/OpenCode typecheck and regression logs are
`tool_0fb5069160013mr2cqCHNJCJTn`, `tool_0fb50691d001KaIIcWCqv7r7Qx`, and
`tool_0fb506924001hCJYkBG2NT6v6T`. Suite results overlap; they must not be summed
as unique coverage. Deliberately injected HTTP 503 recovery diagnostics are not
failed tests. An initial new TUI fixture used non-contract fields in a typed diff
event; that fixture type error was corrected before the passing rerun.

#### Independent P2: deleted Session can poison connection recovery

Before this correction, recovery gathered legacy cached Session/message IDs and
called `session.sync` for each. A Session deleted by another client during an
outage returned an authoritative 404 from `session.get`; that rejected the entire
recovery batch. Retries retained the same ID, so every connection failed recovery
and unrelated submissions remained blocked in `eventsReady()`. An observed
`session.deleted` removed only the legacy Session summary, leaving its message
cache eligible for recovery in default nonselective mode. V2 message hydration
had the analogous fatal 404 path when its cached Session disappeared.

The regression uses the actual SDK over HTTP/SSE, not store-only injection.
All four deletion cases (missed during EOF versus observed before EOF, each in
default and selective modes) reproduced the block before the fix: **0 passed,
4 failed**, with repeated Session-not-found reads and no survivor POST. Failed
reproduction log: `tool_0fb6b060e001rqGlEJVGo8fNgD`.

`isSessionNotFound` now requires the SDK error's HTTP status to be **404** and a
recognized body: the legacy session-get `NotFoundError`, or V2's
`SessionNotFoundError` with the matching Session ID. It does not accept an arbitrary
404, a network failure, or a 503 even when its body names `NotFoundError`.
Epoch/tracker fences prevent old hydration errors from removing current state.
Other errors are rethrown into the existing reconnect/retry path.

Session-interest removal synchronously releases the deleted identity's local
selection/control/submission membership and notifies both providers. They remove
legacy summaries, messages/parts, todos/diffs/status, pending requests and hydration
cache membership, plus V2 info/messages/requests, sequence and volatile trackers.
The same cleanup applies to a live deletion event. Pending or late hydration can
no longer mark that deleted identity fully synced or restore its cached transcript.
Older queued events are flushed before pruning, so batched Session updates cannot
restore a summary after its deletion. Observed-deletion tests include those
back-to-back metadata updates before the deletion frame.

The four regression cases assert survivor submission dispatch, absent legacy and
V2 caches, revoked deleted-Session interest/ownership, and **no new requests for
the deleted ID on another reconnect**. A fifth deletion case caches the Session
only in V2, so legacy cache removal cannot mask a failing V2-only recovery path.
Two additional actual HTTP regressions
assert that session-get 503 and untyped 404 failures keep cached state and block
submissions until a fresh successful snapshot; the existing global-snapshot 503
recovery regression also remains passing.

From `packages/tui`, using `fix-events-tmp` under the shared lock:

```sh
bun typecheck && bun test --timeout 15000 \
  test/cli/tui/event-recovery.test.tsx \
  test/cli/cmd/tui/sync-live-hydration.test.tsx \
  test/cli/tui/event-interest.test.tsx \
  test/cli/tui/data.test.tsx test/session-interest.test.ts
```

passes **45 tests / 257 assertions / 5 files, 0 failures**, including all six new
cases before adding the V2-only case. Log: `tool_0fb6e88ee001LAkUCzMHERQDra`. The intentionally rejected 503 and
untyped 404 emit retry diagnostics in this passing suite. The first fixture
typecheck omitted the required deletion-event `sessionID`; that fixture contract
was corrected before this run.

The broader dependent-context suite also passes **59 tests / 219 assertions /
13 files**: `bun test --timeout 15000 test/cli/cmd/tui
test/cli/tui/event-batch.test.ts test/cli/tui/sdk-batch.test.tsx
test/cli/tui/permission.test.tsx test/context/sdk-shutdown.test.tsx
test/app-lifecycle.test.tsx test/util/error.test.ts` from TUI, under the same lock
and `fix-events-tmp` (`tool_0fb703389001wtBgRakAZNG47s`). Its remote-auth bootstrap
diagnostic is deliberately exercised by a passing lifecycle test. OpenCode's
consumer typecheck passes after these production TUI changes under the same
lock/TMPDIR (`tool_0fb703391001MKX6h7kWrgzXl5`). These suites overlap with earlier
coverage and are not an additive unique-test count.

After adding the isolated V2-only deletion case and fencing batched updates before
removal, the final combined TUI command passes **97 tests / 463 assertions /
17 files, 0 failures**, together with the TUI typecheck:

```sh
# packages/tui, shared lock and disk-backed fix-events-tmp as above
bun typecheck && bun test --timeout 15000 \
  test/cli/cmd/tui test/cli/tui/event-recovery.test.tsx \
  test/cli/tui/event-interest.test.tsx test/cli/tui/data.test.tsx \
  test/session-interest.test.ts test/cli/tui/event-batch.test.ts \
  test/cli/tui/sdk-batch.test.tsx test/cli/tui/permission.test.tsx \
  test/context/sdk-shutdown.test.tsx test/app-lifecycle.test.tsx \
  test/util/error.test.ts
```

Final log: `tool_0fb74858a001gMIVtnuOY5fSby`. This supersedes the two narrower
subgroup runs for current TUI recovery verification and includes all seven new
actual HTTP/SSE cases. No Protocol/HttpApi contract or generated client change
is needed for this deletion fix itself.

#### Follow-up P2 paths: request-only caches and held request snapshots

A subsequent independent review found two deletion schedules that the seven
hydration-oriented cases above did not close. The prior 97-test adequacy statement
is superseded by this follow-up.

- A view-only `permission.v2.asked`/`question.v2.asked` can create request caches
  with no transcript or legacy Session summary. Recovery still reads that
  Session's request endpoints. The real `SessionLocationMiddleware` checks the
  Session row before request handlers run and returns **typed Session-not-found
  404** when it is absent. Previously those reads had no deletion handling, and
  the HTTP fixture masked the route semantics by returning empty arrays. An
  automatic controller's separate legacy-provider V2 permission read had the
  same unhandled error path.
- In default mode a global or per-session request response can be held across a
  `session.deleted` event within the same connection epoch. Immediate cleanup
  was correct, but installing the held response restored deleted permission and
  question caches, and legacy status. Those revived identities could participate
  in the next recovery again.

Executable red evidence is retained in `tool_0fb7f79fa001CnFbEV8xBoWl54`:
**0 passed / 3 failed**. Both view-only and controlled request-only cases timed
out with repeated typed 404s and no survivor POST; the same-epoch held-snapshot
case restored the deleted legacy permission array. The fixture now explicitly
marks removed Sessions and returns the production middleware's typed 404 for
their per-session permission/question routes, before any handler override.
Earlier transcript-deletion tests use this correct request-route behavior too.

Both recovery trackers now record removed Session IDs. Matching typed V2 404s on
per-session request reads prune that identity and contribute empty request arrays;
an automatic controller's permission reads/replies use the same scoped handling.
The epoch and current-recovery tracker must match before a response may cause
removal. V2 requires a matching `SessionNotFoundError.sessionID`; the unscoped
legacy `NotFoundError` form is accepted only by legacy `session.get`.

Install-time filters exclude removed IDs from global and per-session permission
and question snapshots, preserved live requests, and legacy status maps. Automatic
reply loops also recheck removal and ownership before dispatch. A failure for a
Session already authoritatively removed during that recovery is obsolete; all
other transient, untyped, or mismatched-Session errors remain retryable.

Six further actual HTTP/SSE cases cover these paths:

1. Request-only view-only deletion, with no message hydration to trigger cleanup.
2. Request-only automatic-controller deletion, including its independent read.
3. Held global **and per-session** legacy/V2 approval/question snapshots and legacy
   status across a deletion in the **same epoch**. Deleted state remains absent,
   survivor requests/status remain present, its POST resumes, and the next
   reconnect makes no reads for the deleted identity.
4. Request-only 503, untyped 404, and typed 404 naming a different Session. All
   retain cached state, retry the connection, and block dispatch until a fresh
   successful snapshot is installed.

The combined current-source TUI verification passes **103 tests / 524 assertions /
17 files, 0 failures**, with its typecheck passing. Exact command from
`packages/tui`, under the same shared lock and `fix-events-tmp`:

```sh
bun typecheck && bun test --timeout 15000 \
  test/cli/cmd/tui test/cli/tui/event-recovery.test.tsx \
  test/cli/tui/event-interest.test.tsx test/cli/tui/data.test.tsx \
  test/session-interest.test.ts test/cli/tui/event-batch.test.ts \
  test/cli/tui/sdk-batch.test.tsx test/cli/tui/permission.test.tsx \
  test/context/sdk-shutdown.test.tsx test/app-lifecycle.test.tsx \
  test/util/error.test.ts
```

Log: `tool_0fb8361e70017KqvqUwDOkngZ0`. Expected transient-error diagnostics are
part of passing retry regressions. Core's typecheck plus process/job/session-work
regressions also pass **42 tests / 524 assertions / 5 files**:

```sh
# packages/core, shared lock and disk-backed fix-jobs-tmp
bun typecheck && bun test --timeout 15000 \
  test/effect/cross-spawn-spawner.test.ts test/background-job.test.ts \
  test/session-work.test.ts test/session-work-execution.test.ts \
  test/plugin/command.test.ts
```

Core log: `tool_0fb8361ee001UlrKWfnoM3oyc4`. OpenCode's consuming-package
`bun typecheck` passes under the same lock and `fix-events-tmp`:
`tool_0fb8361fb001ogMP3FHKNb8RG4`. Counts from earlier overlapping TUI runs are
not additional unique tests.

The request-only cases were then strengthened to require exactly one new SSE
connection/epoch after EOF. This proves the controlled provider handles its 404
within the recovery batch rather than rejecting once and succeeding only on an
extra retry after another provider prunes the Session. The focused command
`bun test --timeout 15000 test/cli/tui/event-recovery.test.tsx -t
'request-only.*deleted'`, from TUI with the same lock and `fix-events-tmp`, passes
**2 tests / 28 assertions, 0 failures** (29 unrelated cases filtered):
`tool_0fb86aa08001f0tIpyZiYCTCa3`. Exact cache-removal, survivor-dispatch and
next-reconnect no-stale-read assertions remain intact.

**Adequacy:** after closing request-only and same-epoch late-snapshot recovery as
well as transcript hydration, focused Linux source behavioral coverage is adequate for the
shared-server diff and its principal merge interactions. This is not a claim
that every incoming LSP/config/session change or the whole repository was tested.
Five existing MINI/direct-footer interaction tests remain skipped. Windows
confidential split transport, full-TUI bounded resync, client-close ownership and
whole-Location eviction retain the documented boundaries.

The strengthened validation fixture initially omitted `$schema`, which the
backend legitimately inserts while loading a project config. The fixture now
supplies that schema up front so the exact-file and absent-migration assertions
specifically test client-side TUI migration rather than backend schema insertion.
The final `bun test --timeout 15000 test/cli/tui-shutdown.test.ts`, from OpenCode
under the same lock with `fix-rpc-tmp`, passes **7 tests / 24 assertions**:
`tool_0fb67732b0015Q55w9rvtlFh3p`. Scoped Prettier checks and both unstaged/staged
`git diff --check` pass; no unresolved index entries remain.

**Merge completion prerequisites:** the parent should confirm Client and legacy
SDK regeneration against the merged public Protocol/HttpApi (through generators,
never manual generated edits), current Schema/Protocol/legacy-SDK typechecks,
and a newly built current-merge native artifact with MINI/full-TUI,
background-output release/cancellation, and opt-in native V2 event-interest
correctness checks. The parent subsequently reported successful fixed4 native
flows; that frozen artifact predates these request-only/held-snapshot corrections
and is not current-source evidence for them. A later separately frozen build is
needed; fixed4 must not be overwritten. Any build made before this audit's CLI
error-reporting and deleted-Session recovery fixes does not include those fixes.
No native build/deployment or performance measurements
were performed by this review, and the merge remains uncommitted.

#### Current-merge generator and native verification (2026-10-02)

This follow-up uses the same integration worktree, HEAD `763303faef` and
pending MERGE_HEAD `1fa5a03b5f9b92836bd8e9253b4af9d3c3f93927`, including the
unstaged CLI error deduplication and deleted-Session TUI recovery corrections.
It supplements the source audit; fixed3 remains pre-merge evidence.

All substantial commands use `flock /tmp/opencode/shared-server-bench.lock` and
disk-backed TMPDIRs under `/home/shawn/code/opencode-server-bench-results`.
The generator scripts were inspected before execution and require no dependency
installation. Both completed with exit 0 and reproduced the merged generated
files exactly (`git diff -- packages/client/src/generated
packages/client/src/generated-effect packages/sdk/js` is empty). Consequently,
the already passing current-merge Client/Server/sdk-next checks above remain
applicable; regeneration introduced no consumer changes requiring a rerun.

Logs below are in `/home/shawn/.local/share/opencode/tool-output/`:

| Working directory   | Command after lock and `env TMPDIR=.../fix-events-tmp` | Result                                                         | Log                               |
| ------------------- | ------------------------------------------------------ | -------------------------------------------------------------- | --------------------------------- |
| `packages/client`   | `bun run generate`                                     | exit 0; no generated diff                                      | `tool_0fb790677001Ee9sEptk0w0z6g` |
| Worktree root       | `./packages/sdk/js/script/build.ts`                    | exit 0; no generated diff; script's own SDK compilation passed | `tool_0fb791127001d3iQvoGgMmwW8n` |
| `packages/schema`   | `bun typecheck`                                        | exit 0                                                         | `tool_0fb7942f4001sc0r4dcAVNP0nZ` |
| `packages/protocol` | `bun typecheck`                                        | exit 0                                                         | `tool_0fb7951350012I97nRDCKe859D` |
| `packages/sdk/js`   | `bun typecheck`                                        | exit 0                                                         | `tool_0fb798e5600181M0jma11rwRkl` |

The current-merge Linux x64 native build passed (exit 0), including the build's
compiled `--version` smoke, with embedded Linux native reminders. From
`packages/opencode`, the exact command was:

```sh
flock /tmp/opencode/shared-server-bench.lock env \
  HOME=/home/shawn CARGO_HOME=/home/shawn/.cargo \
  TMPDIR=/home/shawn/code/opencode-server-bench-results/fix-build-tmp \
  OPENCODE_VERSION=0.0.0-shared-server-fixed4-20261002 \
  bun run script/build.ts --single --skip-install --skip-embed-web-ui
```

Build log: `tool_0fb79b2fd001fVTrxgV7MCMKuB`. A new, initially absent directory
`/home/shawn/code/opencode-server-bench-results/artifacts/shared-server-fixed4`
holds the frozen mode-0555 `opencode` and `provenance.json`. The frozen artifact
and `packages/opencode/dist/opencode-linux-x64/bin/opencode` have identical SHA256:

```text
694f47e267cf5ed4c46696027eb97a8757f2e110a0f234b632030678b2adf24a
```

The frozen artifact independently reports
`0.0.0-shared-server-fixed4-20261002` from `--version`. Provenance records both
Git parents and the HEAD-relative staged-plus-unstaged production-source diff
SHA256 `5b90004597f46bec5ddeb3d4c4a8d53b1f0a3cd21f78ffa6e656937d4339eee0`:
`git diff HEAD --binary -- packages/core/src packages/opencode/src
packages/tui/src packages/schema/src packages/protocol/src packages/server/src
packages/client/src packages/sdk/js/src | sha256sum`. That fingerprint was
rechecked unchanged after all native checks. This build includes the pending
audit corrections; it is not the pre-merge fixed3 executable.

For the three Python correctness commands below, the working directory is the
worktree root. `BIN` is the absolute frozen fixed4 executable above, `ROOT` is
`/home/shawn/code/opencode-server-bench-results`, and each output root was checked
absent before its first invocation. Commands are prefixed with
`flock /tmp/opencode/shared-server-bench.lock env TMPDIR="$ROOT/fix-build-tmp"
PYTHONDONTWRITEBYTECODE=1` (the job-cycle command uses `fix-jobs-tmp` instead).

| Command after prefix                                                                                   | Result / evidence              | Log                               |
| ------------------------------------------------------------------------------------------------------ | ------------------------------ | --------------------------------- |
| `python3 script/server-mini-flow.py --binary "$BIN" --out "$ROOT/af-mini4" --resource-policies`        | exit 0; `af-mini4/result.json` | `tool_0fb7a907e001hjHk41MjL82Suw` |
| `python3 script/server-mini-flow.py --binary "$BIN" --out "$ROOT/af-full5" --full --resource-policies` | exit 0; `af-full5/result.json` | `tool_0fb7aa0c1001sMP7bJ77DttaPO` |
| `python3 "$ROOT/native-job-cycle.py" --binary "$BIN" --out "$ROOT/af-job5"`                            | exit 0; `af-job5/result.json`  | `tool_0fb7ab121001DsH9M6hCu1Tdo6` |

Both real local-provider/PTY modes assert permission-footer approval, completed
tool output and assistant rendering, resume replay, exact forked history with
unchanged original history, and attached/local headless runs. Resource-policy
mode also exercises native worker search retirement and reopening. The separate
job cycle proves short-lived output is persisted and released, deleting only its
own archived tail preserves `completed`/exit-0 with exact `expired` availability,
and another Session's live process is cancelled with its original PID/start-time
identity gone. Its owned daemon stop asserts exit 0.

From `packages/opencode`, the native V2 check ran:

```sh
flock /tmp/opencode/shared-server-bench.lock env \
  -u NATIVE_EVENT_OUT -u NATIVE_EVENT_BASELINE \
  TMPDIR=/home/shawn/code/opencode-server-bench-results/fix-events-tmp \
  NATIVE_EVENT_BIN=/home/shawn/code/opencode-server-bench-results/artifacts/shared-server-fixed4/opencode \
  bun test --timeout 60000 test/server/native-event-interest.test.ts
```

Result: **1 passed, 0 failed, 14 assertions, no skips**; log
`tool_0fb7ac40e001NluOdp8r2TSV40`. It verifies persisted descendant ancestry,
selected/metadata-only/unfiltered transcript isolation, native durable tool output
and snapshot sequence, authoritative permission/question lists and replies, and
daemon exit 0. `NATIVE_EVENT_OUT` is unset so the optional performance-output
branch does not run; this is a correctness check, not a benchmark.

**Cleanup and preservation:** daemon PIDs `1816447` (MINI), `1818064` (full TUI),
and `1820714` (job cycle), taken from the owned startup logs, are absent (`ps -p
1816447,1818064,1820714 -o pid=,stat=,args=` returns 1 with no rows). An anchored
`pgrep -af` for the unique fixed4 executable finds no remaining process. None of
the three owned `daemon` directories contains `server.json` or `server.sock`;
their logs are retained. The native-event fixture is automatically disposed and
asserts its spawned daemon exit. Prior comparator, fixed2 and fixed3 hashes were
reverified against their recorded values and are unchanged. No external process
was killed, dependency installed, original checkout/global binary modified,
performance workload run, or file staged/committed/pushed by this follow-up.

**Intermediate fixed4 evidence:** the generator, remaining typecheck, build and
compiled checks above passed for the recorded source fingerprint. A subsequent
independent review identified two remaining P2 deleted-Session recovery paths:
permission/question request-only caches can perpetually fail recovery on a typed
404, and same-epoch held approval/status HTTP snapshots can restore deleted cache
state after a live `session.deleted`. The source-audit agent is addressing those
findings and regressions. Fixed4 predates those additional corrections and is
valid intermediate artifact evidence, not final verification of the corrected
source or a claim that all bugs are closed. A later build and relevant checks are
required after those fixes; no further build was started by this follow-up.
The five existing direct-footer skips and documented platform/deferred boundaries
remain as recorded. The merge remains uncommitted for parent review.
Final scoped Prettier and both unstaged/staged
`git diff --check` passed, and `git diff --exit-code --
packages/client/src/generated packages/client/src/generated-effect packages/sdk/js`
confirmed no regeneration drift (log `tool_0fb7c6bf4001lAk40ulD20HwnU`). No
unresolved index entries remain.

#### Fixed5 native verification after both follow-up P2 corrections

Fixed5 is a new, separately frozen Linux x64 artifact built from the current
integration worktree after the request-only typed-404 and same-epoch held-request
snapshot corrections above. It includes those production changes in `data.tsx`,
`sync.tsx` and `util/error.ts`, along with the prior CLI and recovery audit fixes.
HEAD remains `763303faefdef57cf6ae2e7bc0b6277243dd7d02` and pending MERGE_HEAD
remains `1fa5a03b5f9b92836bd8e9253b4af9d3c3f93927`. Fixed4 and all older artifacts
remain immutable intermediate/historical evidence.

The latest fixes do not change Protocol/HttpApi. The generators reproduced the
merged outputs in the fixed4 verification above, so no regeneration was needed.
Current source typechecks and behavioral results remain those recorded above:
TUI **103 / 524 / 17**, Core **42 / 524 / 5**, with both package typechecks and
OpenCode's consuming-package typecheck passing. These source regression results
are separate from the compiled integration flows below.

From `packages/opencode`, the following build completed with exit 0, including
the compiled version smoke and embedded Linux native reminders:

```sh
flock /tmp/opencode/shared-server-bench.lock env \
  HOME=/home/shawn CARGO_HOME=/home/shawn/.cargo \
  TMPDIR=/home/shawn/code/opencode-server-bench-results/fix-build-tmp \
  OPENCODE_VERSION=0.0.0-shared-server-fixed5-20261002 \
  bun run script/build.ts --single --skip-install --skip-embed-web-ui
```

Build log: `tool_0fb901b92001lBz7zgvAGU4m24`. The verified parent directory and
initially absent `artifacts/shared-server-fixed5` name were checked before copying
the native executable there with no-clobber semantics and mode 0555. Both the
frozen executable and `packages/opencode/dist/opencode-linux-x64/bin/opencode`
have SHA256:

```text
66e51578f0435b127a730627fb920ce2846899d2632b224c580c574baf8adb22
```

Its independent `--version` reports `0.0.0-shared-server-fixed5-20261002`.
`artifacts/shared-server-fixed5/provenance.json` records the parents, build/log
and HEAD-relative staged-plus-unstaged production-source diff SHA256
`1b1945b1eafc672f47c1f78854a2fb58bcd49280922bab717e65ecc5991f7b83` using the
same source-path diff command as fixed4. The changed fingerprint distinguishes
this build from fixed4's pre-follow-up sources.

All four compiled correctness checks passed against that exact frozen fixed5
executable. For the three Python commands below, `BIN` is
`/home/shawn/code/opencode-server-bench-results/artifacts/shared-server-fixed5/opencode`
and `ROOT` is `/home/shawn/code/opencode-server-bench-results`. They ran from the
worktree root, each after asserting its output directory did not exist, prefixed
with `flock /tmp/opencode/shared-server-bench.lock env
TMPDIR="$ROOT/fix-build-tmp" PYTHONDONTWRITEBYTECODE=1` (the archive cycle uses
`fix-jobs-tmp` instead). No existing root was reused or overwritten.

| Command after prefix                                                                                   | Result / evidence              | Log                               |
| ------------------------------------------------------------------------------------------------------ | ------------------------------ | --------------------------------- |
| `python3 script/server-mini-flow.py --binary "$BIN" --out "$ROOT/af-mini5" --resource-policies`        | exit 0; `af-mini5/result.json` | `tool_0fb90abab001u682ZRHPZnvExy` |
| `python3 script/server-mini-flow.py --binary "$BIN" --out "$ROOT/af-full6" --full --resource-policies` | exit 0; `af-full6/result.json` | `tool_0fb90bd0b001yyHre7Ck2v1ONP` |
| `python3 "$ROOT/native-job-cycle.py" --binary "$BIN" --out "$ROOT/af-job6"`                            | exit 0; `af-job6/result.json`  | `tool_0fb90cf72001yTINYUQktOcMjs` |

MINI and full TUI both pass real local-provider/PTY permission-footer approval,
completed tool output and rendered response, resume replay, exact fork history
with the original preserved, attached/local headless execution, and native worker
search retirement/reopening. Each records five provider calls. The independent
archive cycle passes output persistence/release, exact `expired` availability
after deletion of its own retained tail while preserving completed/exit-0 status,
and cancellation of another Session's live job with the original process identity
gone. Its daemon stop asserts exit 0. All three result files record the fixed5
binary hash above.

The opt-in native V2 event-interest check, from `packages/opencode`, was:

```sh
flock /tmp/opencode/shared-server-bench.lock env \
  -u NATIVE_EVENT_OUT -u NATIVE_EVENT_BASELINE \
  TMPDIR=/home/shawn/code/opencode-server-bench-results/fix-events-tmp \
  NATIVE_EVENT_BIN=/home/shawn/code/opencode-server-bench-results/artifacts/shared-server-fixed5/opencode \
  bun test --timeout 60000 test/server/native-event-interest.test.ts
```

It passes **1 test / 14 assertions / 1 file, 0 failures, no skips**; log
`tool_0fb90e57c001CdY7Dw4jb7bK2I`. Assertions cover persisted descendant ancestry,
selected/metadata-only/unfiltered transcript isolation, native durable tool output
and sequence-fenced snapshot, permission/question list-and-reply behavior, and
daemon exit 0. Optional performance output and baseline mode were explicitly
unset. These integration flows do not inject the new deletion schedules; those
are exercised by the actual HTTP/SSE source regressions above, and the new native
artifact is verified to contain their production corrections.

**Final provenance/preservation:** after all native flows, the same HEAD-relative
production-source fingerprint remained
`1b1945b1eafc672f47c1f78854a2fb58bcd49280922bab717e65ecc5991f7b83`, and the
fixed5 executable still matched dist. `git diff --exit-code --
packages/client/src/generated packages/client/src/generated-effect packages/sdk/js`
passed with no output. The prior shawnd/shared-server comparator, fixed2, fixed3
and fixed4 binary hashes match their recorded values. Fixed4's provenance file
also remains unchanged at SHA256
`2bcc3f5fa5166da8fb426ca86cc97761d0076b5b2c09718e17214258dfdf4f90`.
These checks are logged in `tool_0fb91662b0014s9n6MA2sHzhft`.

**Owned cleanup:** startup logs identify daemon PIDs `1996833` (MINI), `1998253`
(full TUI), and `2000783` (archive cycle). Under the shared lock,
`ps -p 1996833,1998253,2000783 -o pid=,stat=,args=` returns 1 with no rows, and an
anchored `pgrep -af` for the unique fixed5 executable finds no remaining process.
The three new roots retain only `daemon/server.log`, with no `server.json` or
`server.sock`. The native-event test asserts its own daemon's exit 0 and its
`fix-events-tmp/opencode-test-5ziuqd6kstk` fixture was disposed. No other process
was killed and all new evidence is retained.

**Completion boundary:** fixed5 supplies the current-source compiled evidence
that fixed4 could not provide after the two follow-up P2 corrections. The listed
generator/typecheck/build/native prerequisites are satisfied for the recorded
source fingerprint. Together with the source regressions, this provides focused
Linux integration verification, not a whole-repository/full-suite claim. Five
preexisting direct-footer skips, Windows confidential split transport, full-TUI
bounded resync, client-close ownership and whole-Location eviction retain the
documented boundaries. No correctness failure or new blocker was found in this
native follow-up. No production/generated source, dependency installation, global
binary, original checkout, staged index, commit or remote was changed by it, and
no performance workload was run. The merge remains uncommitted for parent review.

#### Incoming LSP/config/session/tool suite coverage follow-up

This follow-up executes the incoming changed suites in the integration worktree
to close the earlier explicit LSP/config/session verification gap. Commands run
from `packages/opencode` under the original
`flock /tmp/opencode/shared-server-bench.lock`, with existing disk-backed TMPDIRs.

With `TMPDIR=/home/shawn/code/opencode-server-bench-results/fix-events-tmp`:

```sh
bun test --timeout 30000 test/lsp test/config/config.test.ts \
  test/command/command.test.ts test/cli/install.test.ts
```

passes **238 tests / 461 assertions / 10 files, 0 failures**, with **2 skips**
in 24.86 seconds. Log: `tool_0fcd7782b001OT4X8jHjo1tmOT`. The skips are the
real Zsh and Fish alias execution tests because those shells are absent; Bash
execution and config-writing/CLI assertions remain exercised. The Windows-only
cmd launch test returns early on Linux and does not verify Windows execution.

LSP coverage uses actual child-server protocol fixtures for cancellation/deadline
handling, retirement of uncooperative servers, idle reclamation with active RPCs,
document pinning/eviction/reopening, stale diagnostics, bounded retention and
shutdown, alongside capability negotiation, push/pull diagnostics and root
discovery. Config regressions cover interrupted cached-load recovery, equal-sized
content changes with unchanged mtimes, deletion/precedence and synchronized
concurrent global MCP/approval writes. Command and install tests resolve built-ins
and exercise real isolated CLI subprocesses, shell quoting and managed-block
preservation.

With `TMPDIR=/home/shawn/code/opencode-server-bench-results/fix-jobs-tmp`:

```sh
bun test --timeout 30000 test/session/llm.test.ts \
  test/session/processor-effect.test.ts test/session/prompt.test.ts \
  test/session/revert-compact.test.ts test/session/system.test.ts \
  test/tool/code-mode.test.ts test/tool/lsp.test.ts \
  test/tool/registry.test.ts test/tool/task.test.ts
```

passes **234 tests / 886 assertions / 9 files, 0 failures**, with **1 existing
skip**, in 67.97 seconds. Log: `tool_0fcd78918001FzlWaxsMmcRriC`. The skipped
case is `prompt emits v2 prompted and synthetic events (v2 projector disabled)`;
the active projector/native-event checks documented above provide separate
coverage, not execution of this disabled-projector case.

These suites exercise role-denial ceilings despite inherited grants, own/ancestor
allow exceptions, actual tool-side-effect prevention and approval-before-effect,
doom-loop restrictions, MCP tool/catalog/instruction visibility, task resume
identity validation and permission refresh, nested/background task cancellation,
queued-input undo without interrupting active work, and compaction undo/redo
history. Provider fixtures are local test authorities; no paid provider calls are
required. The real LSP tool regression also verifies navigation completes without
waiting for a server that never publishes diagnostics.

**Adequacy:** the requested incoming LSP/config/command/install/session/tool gap
is now closed for the merged Linux diff: the two disjoint groups pass **472 tests,
1,347 assertions across 19 files**, with three explicitly identified skips and no
failures. This complements the already passing shared-server, permission,
session-work, HTTP Session, TUI, generator/typecheck and fixed5 native evidence;
overlapping earlier results are not added into a unique whole-audit total. Focused
behavioral coverage is adequate for the combined diff's Linux scope, with the
documented platform/deferred boundaries and skipped cases retained.

Only this audit report changed during this follow-up. A post-suite check under
the shared lock confirms the production-source fingerprint remains
`1b1945b1eafc672f47c1f78854a2fb58bcd49280922bab717e65ecc5991f7b83`.
Fixed5 remains current-source native evidence; these runs introduce no source
mutation requiring another native build or correctness rerun. Report Prettier
checking and staged/unstaged whitespace checks pass. The merge remains pending
parent review and commit.

## High-priority findings

### H1 — Unix requests inherit a ten-second transport timeout

- **Location:** `packages/opencode/src/cli/daemon-server.ts:47–55`.
- **Scope:** Default shared daemon on Unix platforms.
- **Trigger:** A nonstreaming prompt or shell request executes for longer than
  ten seconds without response bytes.
- **Impact:** Bun resets its connection even though the operation has been
  admitted. The client can report submission failure; continuation/cancellation
  then depends on the execution boundary. The Unix branch omits `idleTimeout: 0`,
  which is present only in the TCP branch.
- **Evidence:** Bun's documented default includes in-flight handlers that have
  not written bytes: <https://bun.com/docs/runtime/http/server#idletimeout>.
  Legacy prompt/shell handlers await execution before returning their response
  (`handlers/session.ts:285–320`). Ten-second SSE heartbeat spacing also leaves
  no timeout margin; its actual failure frequency has not been reproduced.
- **Fix/test:** Disable the Unix listener's idle timeout. Test an actual Unix
  daemon request beyond ten seconds and an idle stream across several heartbeats.

### H2 — Stuck project initialization blocks unrelated shutdown cleanup

- **Locations:** `packages/opencode/src/cli/daemon-server.ts:125–134`,
  `packages/opencode/src/project/instance-store.ts:166–181`.
- **Scope:** Default daemon with a stuck initializing project.
- **Trigger:** Project A's plugin initialization never completes; another
  project B owns a detached background subprocess; then stop the daemon.
- **Impact:** Disposal awaits A before reaching B. The shared ten-second timeout
  expires before later HTTP/AppRuntime disposal runs, and CLI exit can leave B's
  detached subprocess alive. Background-shell process termination is a scoped
  finalizer (`packages/opencode/src/background/shell.ts:147–183`).
- **Fix/test:** Start independent cleanup before waiting for initializing
  entries, and ensure listener/runtime finalization still runs after a timeout.
  Extend the existing stuck-plugin test with a healthy project's real process
  group and assert its disappearance, not just daemon exit and endpoint removal.

### H3 — Discovery can trust a forged daemon under hostile temporary ancestry

- **Locations:** `packages/opencode/src/cli/daemon.ts:65–66,82–95,116–120,171–177`.
- **Scope:** No private, correctly owned `XDG_RUNTIME_DIR`; discovery ancestry
  can be precreated or controlled by another local user.
- **Trigger:** Precreate the predictable `<tmp>/opencode-<uid>/<profile>` hierarchy
  with readable metadata directing the victim to a fake server reporting protocol 1.
- **Impact:** `read()` contacts the supplied URL/socket before any directory
  hardening. `ensure()` accepts it using only the reported protocol. Client
  prompts/content can be sent to an impersonated backend. Ownership, symlinks,
  metadata permissions, endpoint locality, and server identity are not checked.
  Tightening only a profile leaf does not secure an attacker-owned parent.
- **Fix/test:** Validate discovery ancestry and metadata before contacting the
  endpoint. Cover hostile parents, symlinks, forged metadata, remote URLs, and
  genuine owned discovery/replacement. No cross-user exploit was executed.

### H4 — Reuse can discard a later invocation's security restrictions

- **Locations:** `packages/opencode/src/cli/daemon.ts:44–61,133–144`,
  `packages/opencode/src/config/config.ts:464–487,603–608`.
- **Scope:** An existing daemon launched with different backend restriction flags.
- **Trigger:** Start an unrestricted daemon, then open a plugin-bearing project
  with `OPENCODE_DISABLE_PROJECT_CONFIG=1`, retaining the same hashed profile inputs.
- **Impact:** The flag is absent from the profile and only the first launcher's
  environment reaches the daemon. Backend project config/plugins still load,
  although the client-side TUI config honors the later restriction. A later
  `OPENCODE_PERMISSION` restriction is likewise not reconciled with legacy config.
- **Fix/test:** Partition/reject reuse for incompatible restrictions or pass an
  explicit effective policy. Test a second client opening a project under a
  stronger restriction. Documented first-launch environment inheritance explains
  the behavior but does not eliminate this security consequence.

### H5 — Selective reconnects miss pending approvals and status changes

- **Locations:** `packages/tui/src/context/sdk.tsx:121–158,184–187`,
  `packages/tui/src/context/sync.tsx:225–229`,
  `packages/tui/src/context/data.tsx:497–502`.
- **Scope:** `OPENCODE_EXPERIMENTAL_EVENT_INTEREST=1`; ordinary connection outages
  also expose the underlying lack of authoritative request/status recovery.
- **Trigger:** Change interests while work runs; emit an approval/question, answer
  an existing request, or change status after disconnect and before resubscription.
- **Impact:** Global visibility protects subscribed clients only. Reconnect
  refreshes transcripts, not pending requests/status, so an approval may never
  appear or an answered one may remain. Work awaiting approval can stay blocked.
  Ordinary EOF/retry also retains an already-resolved readiness promise, permitting
  submission during reconnect backoff.
- **Fix/test:** Reconcile authoritative requests/status for a new connection
  epoch before declaring submission readiness. Use actual SDKProvider SSE
  replacement, not only injected events, with changes in the disconnected window.

### H6 — Reconnect can accept hydration from before the disconnection

- **Locations:** `packages/tui/src/context/sync.tsx:674–690,744`,
  `packages/tui/src/context/data.tsx:557–568`.
- **Scope:** Legacy reconnect refresh; selective V2 reconnect refresh.
- **Trigger:** Hold a hydration response containing an old snapshot, disconnect,
  commit a message in the gap, reconnect, then release the held response.
- **Impact:** In-flight deduplication returns the old task. No connection-epoch
  invalidation or subsequent refresh is required. The old snapshot is treated as
  recovered; legacy additionally marks it fully synced. An atomic V2 sequence
  does not supply an event absent from both the old snapshot and the new stream.
- **Fix/test:** Fence hydration by connection epoch and require a post-reconnect
  snapshot. Hold a real hydration request across reconnect and commit in the gap.

### H7 — Expired released output can disable unrelated legacy cancellation

- **Locations:** `packages/core/src/background-job.ts:194–205`,
  `packages/opencode/src/background/shell.ts:257–273`,
  `packages/opencode/src/session/run-state.ts:77–85,115`.
- **Scope:** `OPENCODE_EXPERIMENTAL_JOB_OUTPUT_RELEASE`; legacy cancellation.
- **Trigger:** A completed job's acknowledged `.tail` becomes unavailable, through
  deletion or the normal seven-day truncation cleanup, then cancel unrelated work.
- **Impact:** Global `list()` loads every archived terminal output. One failing
  loader defects before cancellation reaches live jobs or the runner, including
  work in another project. Archived descriptors have no matching expiry path.
- **Fix/test:** Keep cancellation independent of historical output reads; make
  archive availability/expiry explicit. Remove an actual released tail and cancel
  real work in another session/project. The small registry probe confirmed
  `list()` failure prevents a following cancel, not end-to-end session cancellation.

## Additional actionable gaps

| ID  | Severity/scope                                     | Finding and source                                                                                                                                                                                                          | Missing coverage / direction                                                                                                                                                                    |
| --- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Medium, daemon lifecycle                           | Accepted stop still reports a reusable daemon until delayed shutdown (`daemon-server.ts:56–61`, `daemon.ts:116–125`).                                                                                                       | Overlap stop acceptance with ensure/attachment; expose and reject/wait for stopping state.                                                                                                      |
| M2  | Medium, default foreground shell                   | Joining a failed output consumer inside first-success `Effect.raceAll` defers failure until abort/timeout, or masks it as timeout (`packages/opencode/src/tool/shell.ts:489–496,569–588`).                                  | Fail output persistence/metadata while the process exits before a long timeout; assert immediate failure and cleanup.                                                                           |
| M3  | Medium, selective opt-in                           | Submission's pre-dispatch `eventsReady()` wait ignores its request-specific abort signal (`packages/tui/src/context/sdk.tsx:43–56,200–208`).                                                                                | Abort before SSE readiness; assert prompt rejection and no POST.                                                                                                                                |
| M4  | Medium, selective V2 hydration                     | Already-received volatile text is discarded when another durable event advances snapshot sequence (`packages/tui/src/context/data.tsx:516–520,572–580`).                                                                    | Buffer text delta A at seq 10, observe another durable fragment at 11, install snapshot 11, then delta B; ensure A survives until full-value settlement.                                        |
| M5  | Medium, inherited legacy merge gap                 | Snapshot installation overwrites newer metadata/todos/diffs; touched-state protection covers messages/parts only (`packages/tui/src/context/sync.tsx:693–696,741`).                                                         | Hold old responses across corresponding live updates; preserve the newer state. Reconnect now exercises this path more often.                                                                   |
| M6  | Medium, bounded/selective opt-ins                  | Overflow during blocked ancestry seeding cannot promptly expose its resync frame; subscription must finish before the pull is returned (`handlers/global.ts:74–105`, `packages/opencode/src/server/event-buffer.ts:63–80`). | Block seed and overflow; require terminal delivery and timer/listener teardown without releasing seed.                                                                                          |
| M7  | Medium, profile isolation                          | Profile omits channel and `OPENCODE_DISABLE_CHANNEL_DB` despite their effect on effective database selection (`daemon.ts:46–61`, `packages/core/src/database/database.ts:55–66`).                                           | Wrapper/direct and cross-channel tests without explicit `OPENCODE_DB`; hash effective database identity.                                                                                        |
| M8  | Medium, inherited proxy path/new shared credential | UI fallback forwards local Basic authorization upstream (`packages/opencode/src/server/shared/ui.ts:83–92`, `packages/opencode/src/server/proxy-util.ts:14–28`).                                                            | Authenticate GET / without embedded UI; assert local credentials are removed before upstream dispatch. Upstream storage/misuse was not established.                                             |
| M9  | Medium, process-visibility dependent               | Herdr split passes the shared password in subprocess argv (`packages/tui/src/util/herdr.ts:15–38,57–58`).                                                                                                                   | Use confidential credential transfer. Other-user exposure depends on process visibility and catching the short-lived process. Helper is inherited; default daemon now supplies a shared secret. |
| M10 | Medium, inherited multi-Location OAuth ownership   | Pending MCP auth state/transports/cancellation use server name rather than Location (`packages/opencode/src/mcp/index.ts:115,896,932–934,987–999`, `mcp/auth.ts:84–94`, `mcp/oauth-callback.ts:133–158`).                   | Overlap same-name auth in two Locations, finish/cancel independently. Interference is established by source; cross-origin token theft is not.                                                   |
| M11 | Medium, inherited explicit-worker RPC              | Worker errors have no RPC rejection reply, so occupied/invalid-port startup can hang and bypass the new cleanup catch (`packages/opencode/src/util/rpc.ts:9–10,45–50`, `cli/cmd/tui.ts:218–221`).                           | Bind failure and worker error/close tests; reject pending calls and bound startup. Existing shutdown test fails only after listener startup succeeds.                                           |

`handlers/global.ts` above means
`packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts`;
`daemon*.ts` means files in `packages/opencode/src/cli`.

## Known deferred integration behavior

- MCP-change events can replace a TUI's local status map with another Location's
  status while dialog controls still target the local Location
  (`packages/tui/src/context/sync.tsx:233–239`, `component/dialog-mcp.tsx:95–147`).
  Same-name configurations make the mismatch especially misleading. This is
  explicitly deferred in `specs/shared-local-server.md:105–109`; it remains a
  concrete integration gap, not evidence of cross-Location tool execution.
- Last-controller/client-close cancellation remains intentionally unimplemented.
- Search retirement protects search leases; it does not establish whole-Location
  eviction safety or complete active-work leases for persistent PTYs.
- Full TUI does not negotiate server bounded delivery. Lossless client batching
  must not be confused with the optional `bounded-v1` recovery protocol.
- Backend environment/credential freshness still follows first-launcher state.
  Exact build-version reuse is intentionally allowed under compatible protocol.
- Default CORS alone was not established as an authentication bypass. Reminder
  sharing is explicit; different client/backend stores can still diverge remotely.

## Probe scope

From `packages/core`, one `bun -e` probe used actual `BackgroundJob.make` and
`start/wait/acknowledge/list/get/cancel`, injecting an archived loader defect.
It composed `jobs.list()` before `jobs.cancel(live.id)`, matching source ordering
without calling `SessionRunState.cancel` or touching filesystem retention. Output:

```json
{"cancellationFailed":true,"liveStatus":"running"}
{"raceResult":"timeout branch"}
```

The second line came from actual `Effect.raceAll` with one failed and one successful
branch. It proves first-success semantics, not shell-tool elapsed timeout or disk
failure behavior. Current Effect source independently documents those semantics
in `packages/effect/src/Effect.ts:4713–4726` in the Effect reference checkout.

## Coverage and next tests

Existing tests meaningfully cover concurrent startup, stale-daemon replacement,
failed validation cleanup, lossless batching, event-interest ownership, output
burst draining, FFF cancellation/disposal, and active search leases. SessionV2
admission/coordinator paths showed no additional concrete regression in this audit.

The largest missing integration tests combine:

1. A real Unix daemon with long-running requests and idle SSE.
2. Stuck initialization in one project and real subprocess cleanup in another.
3. A second invocation with stronger policy and a project plugin.
4. Actual SSE replacement, pending approvals, and a hydration response held across
   reconnect—not merely independent producer/store tests.
5. Expired archived output and cancellation of unrelated live work.

The benchmark was stopped at the user's request. No active N4 benchmark ran;
idle same-project memory savings are not verification of these concurrency and
lifecycle boundaries. All recorded benchmark processes were verified absent.

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

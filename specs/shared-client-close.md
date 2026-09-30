# Interrupt owned work when an interactive client closes

Status: integration plan; not implemented.

## Selected behavior

Closing an interactive client interrupts its sessions and their child agents,
using the same cancellation behavior as confirming Escape. Other clients' work
continues. When two clients control the same session, closing one does not stop
that session; interruption happens when its last controlling client closes.

The daemon remains available. Session history remains durable, and reopening a
session is possible. Merely browsing a session or receiving its global events
does not establish ownership. Claims remain associated with work the client
started even after it navigates to another session.

Apply this to full TUI, `--mini`, and interactive attach/Herdr clients. Explicit
headless work is outside this interactive lifetime policy.

## Existing cancellation boundaries

- `packages/tui/src/component/prompt/index.tsx`: confirmed Escape invokes
  `sdk.client.session.abort({ sessionID })`.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`:
  legacy abort invokes `SessionPrompt.cancel`.
- `packages/opencode/src/session/run-state.ts`: cancellation first cancels
  background jobs transitively using session and parent-session metadata, then
  interrupts the session runner. Reuse this implementation rather than killing
  arbitrary processes or disposing the project.
- `packages/server/src/handlers/session.ts`: V2 interruption invokes
  `SessionV2.interrupt`, backed by process-global `SessionExecution`.
- `packages/core/src/session/run-coordinator.ts`: interruption clears the pending
  wake and waits for active owner cleanup. New wakes can still arrive during
  cleanup, so ownership validation must also cover new work admission.
- `packages/opencode/src/cli/cmd/tui.ts`: shared transport `stop` is currently a
  no-op; the explicit worker path instead shuts down its worker.

Do not assume V2's single-session interrupt supplies legacy background-tree
semantics. Verify descendants and job cleanup for each execution path.

## Integration design

### 1. Explicit client presence and session claims

Create a process-global server-side registry shared by the Unix listener and
the authenticated TCP listener. Register an authenticated interactive client
with an opaque lease token and generation; carry that identity on its work
requests. Keep client/ownership state separate from execution ownership and
EventV2 replay claims.

Track session roots, their location and execution version, and the set of live
controlling clients. Claim before starting or resuming work, including commands,
shell execution and compaction where supported. Explicit interactive resume can
join an existing claim. Observing events or opening a read-only history view must
not automatically keep work alive.

Ownership belongs to the initiating root and is inherited by nested agents and
background jobs. A separately controlled descendant must be protected when its
ancestor's client closes; either reject that independent ownership mode initially
or implement a cancellation boundary that preserves the separately owned branch.

### 2. Graceful close plus crash detection

On normal exit, explicitly release the client's claims and request cancellation
of roots with no remaining controllers. Use bounded cleanup, retaining the lease
until release is acknowledged or the server-side expiry path can finish it.

Maintain a dedicated presence channel or renewable heartbeat lease. Do not use
the existing global SSE subscription as the lifetime signal: subscriptions
reconnect, and more than one can exist per client. A broken presence connection
gets a short reconnect grace period; lease expiry handles crashes, SIGKILL and
terminal destruction when client cleanup cannot run.

Initial timing proposal: heartbeat every 2 seconds, expiry after 10 seconds;
normal explicit close cancels immediately. Make timing injectable for tests.
Reconnect renews the same valid lease generation and must not revive a lease
already closed or expired.

### 3. Reuse session interruption, with race protection

Mark the departing lease closed before cancellation. Reject further work requests
using that generation. Determine roots whose last controller has gone, then use
the legacy or V2 cancellation adapter in the correct location/runtime.

Serialize claim changes and cancellation decisions per root. A fresh controller
must either establish ownership before the decision or wait for old-owner
cleanup; a delayed close or expiry callback must never abort newly claimed work.
Close, heartbeat expiry and repeated signals must be idempotent.

Match Escape's treatment of history, tools and durable pending inputs; do not
invent inbox deletion semantics here. Verify that no stale lease can admit a new
prompt or wake work again after its close decision. Preserve prompts admitted
durably according to the existing session protocol.

### 4. Restart handoff and frontend wiring

`/restart` deliberately replaces the client process while preserving its session.
Provide a bounded one-use handoff to the replacement client rather than treating
the restart gap as an exit. If restart fails, expiry cancels abandoned work.

Wire ownership into the shared transport lifecycle in `cli/cmd/tui.ts`, the full
TUI SDK/work-request boundary, mini runtime session creation/resume and teardown,
and `cli/cmd/attach.ts`. Herdr attach uses the same presence registry over TCP.
Signal handlers are a fast path, not the only cleanup mechanism.

Declare client presence/claim endpoints in the appropriate typed HttpApi and
regenerate Client code with `bun run generate` from `packages/client` after
changing public Protocol or Server HttpApi. Preserve Schema/Core/Protocol/Server
dependency direction; Client runtime must not import Core or Server. Update
daemon protocol compatibility if attachment semantics become mandatory.

## Verification gates

1. Close one real PTY client during a gated model stream: provider cancellation,
   idle/interrupted session state, preserved history, daemon still usable.
2. Repeat during a shell tool with a child process and nested/background agents:
   verify actual subprocess and job cleanup, not just an idle status event.
3. Run two unrelated clients/projects: closing one leaves the other's provider
   stream, tools and pending approvals untouched.
4. Two controllers of one root: first close leaves work running; last close stops
   it. Read-only observers do not retain execution ownership.
5. Crash/SIGKILL, terminal destruction, transient presence disconnect and lease
   expiry: reconnect within grace continues; expiry cancels once.
6. `/restart`: same session and daemon continue without cancellation; failed
   handoff expires. Stale close and expiry callbacks cannot cancel the successor.
7. Race close against prompt admission, new ownership, child creation and cleanup:
   no stale-owner wake; no cancellation of new-owner work.
8. Exercise full TUI, mini, TCP attach/Herdr and legacy/V2 paths. Verify behavior
   during pending permission/question requests and durable queued inputs.

## Delivery sequence

1. Finish the current search-worker synchronization checks independently; retain
   the synchronization stash until verification is complete.
2. Add and test the server presence/ownership registry and cancellation adapters.
3. Add frontend claims, teardown and restart handoff; regenerate API clients.
4. Run focused lifecycle tests and real terminal smoke checks, then build the
   shared-server binary and validate its installed/deployed target as agreed.

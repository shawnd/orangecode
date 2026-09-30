# Server lifetimes: baseline checkpoint (incomplete experiment)

## Status

Stopped at the user's context-budget boundary: `context_usage` reported 113,460
tokens at the first check, exceeding the mandatory 100k stop/report ceiling.
Only the benchmark harness and this report are delivered. No runtime optimization,
experimental policy, or new default has been implemented. No after measurements
exist. This is not a completed BENCH → IMPLEMENT → BENCH → VERIFY track.

## Hypothesis and acceptance criteria

Retain heavyweight project services only while needed; after controlled project
churn, live resources and process PSS should approach startup baseline. Countermetrics
are cold/revisit latency, warm search latency, cleanup latency, and active-work
correctness. Eviction must preserve provider drains, descendant and independent
jobs, PTYs, pending permissions/questions, detached clients, and late admissions.
At least three independent paired measurements on both HTTP cores are required
before claiming an improvement.

## Provenance and workload

- Worktree `/home/shawn/code/opencode-server-lifetimes`, branch `server-lifetimes`.
- Immutable baseline `8998bdb660d66c31a6e390c1195867b6c303c781`.
- Native binary `/tmp/opencode/shared-server-base-bin/opencode`.
- Version `0.0.0-shared-server-202609301000`.
- SHA-256 `9a789076b6e7dda31664a058604a2aa2b8c26f629ce533e8f2d2ddae79e3a2ee` verified before execution.
- Eight isolated small git projects, 100 TypeScript files per project; no commits,
  user credentials, model requests, MCP, or LSP processes.
- Private native shared daemon over its Unix socket; legacy `/find/file` endpoint.
- Isolated HOME/XDG/config/database, pure mode, models fetch/autoupdate disabled.
- `OPENCODE_EXPERIMENTAL_FFF_WORKER=1` equally intended for both arms. This measures
  the opt-in FFF worker backend, not the default direct-native backend.
- Real native FFF workers/indexes/watchers, measured through Linux `/proc`.
- Native daemon PSS only, workers included exactly once as threads. No clients or
  helper fleet PSS. No forced GC or heap snapshot.

## Raw baseline: one sample, legacy core only

| Stage | PSS KiB | RSS KiB | Threads | FFF worker threads | Open FDs | inotify watches |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Ready | 242665 | 274200 | 16 | 0 | 14 | 0 |
| Eight projects visited | 1183253 | 1220912 | 67 | 8 | 58 | 32 |
| After 2.5 s idle | 728241 | 765900 | 67 | 8 | 58 | 32 |
| Revisit first project | 728377 | 766036 | 67 | 8 | 58 | 32 |

Cold request times (ms): 985.364, 397.620, 371.335, 361.977, 578.410,
514.048, 540.041, 495.136. First request includes lazy route/service boot.
Warm request times (ms): 4.167, 2.409, 3.014, 2.900, 4.389, 2.680,
2.548, 2.352, 2.887, 2.673. Revisit: 3.790 ms.
These are raw observations, not confidence intervals or paired medians.
PSS falls naturally during idle but resources remain live. Baseline retention is
demonstrated; the optimization hypothesis has not been tested.

Artifacts:

- `/tmp/opencode/lifetimes-results/base-legacy-1.json`
- `/tmp/opencode/lifetimes-results/base-legacy-1.json.daemon.log`

Exact successful command, from this worktree:

```sh
flock /tmp/opencode/shared-server-bench.lock python script/bench-server-lifetimes.py \
  /tmp/opencode/shared-server-base-bin/opencode \
  /tmp/opencode/lifetimes-results/base-legacy-1.json --arm base --core legacy
```

The harness also defines `--core v2` (`/api/fs/find`) and a future `--arm post`
setting `OPENCODE_EXPERIMENTAL_SEARCH_IDLE_MS=1000`. Neither was exercised, and
that environment variable has **no implementation yet**. Do not interpret those
options as verified functionality.

## Findings and recommended continuation

`core/src/location-services.ts` uses Effect LayerMap with 60-minute idle TTL.
The inspected Effect v4 `LayerMap.make` delegates to `RcMap.get`, which acquires
a scoped reference. `SessionExecutionLocal` provides `locations.get(...)` around
the complete runner drain: existing V2 provider execution is already pinned.
That does not pin a detached PTY created by a short request. The PTY layer's
finalizer kills running PTYs. Legacy BackgroundJob is InstanceState-scoped and
can outlive its admission request. Legacy InstanceState uses infinite-capacity,
infinite-TTL ScopedCache, and InstanceStore disposal is separate from requests.
Blindly shortening either graph lifetime is unsafe.

Both HTTP cores delegate filesystem searching to `core/src/filesystem/search.ts`.
A narrower substantive candidate is a leased idle lifetime for just the native
FFF picker/worker/index and ripgrep scan cache. Search methods can acquire their
own scoped reference, retaining it through native execution and materialization.
This avoids requiring provider/job/PTY ownership just to reclaim an unused search
index. Use explicit opt-in until measured; preserve current whole-graph policy.

Before implementing, verify the installed patched Effect RcMap release/error
semantics. RcMap removes its entry before awaiting scope cleanup, so serialize
retirement/reopening for a location to prevent overlapping old/new native indexes.
Native destroy already awaits admitted FFI and is idempotent. Tests should hold
a real query past idle, interrupt initialization/callers, admit during destruction,
reopen after filesystem/config change, and prove finalization exactly once.
Also verify provider/job/PTY/approval survival past idle with the narrowed policy.

Integration touchpoint for this candidate: `packages/core/src/filesystem/search.ts`
and a dedicated experimental flag. No public API/SDK generation should be needed.
Full graph lifetime reclamation remains blocked on a coherent ownership design.

## Verification and cleanup

- Offline frozen worktree-only dependency installation succeeded under the lock.
- Bun resolution verified `@opencode-ai/core/filesystem/search` resolves into this
  worktree, not another branch.
- Baseline native daemon benchmark exited successfully under the lock.
- Harness terminates/waits for its private daemon and removes its fixture tree
  in `finally`; the successful run completed that cleanup.
- No runtime changes, tests, typecheck, build, deployment, or after arm performed.
- No installed binaries, main/global source, other worktrees, or job registries modified.

Recommendation: accept the benchmark checkpoint only; no optimization is ready
for integration. Resume in a fresh context and complete both-core paired repeats,
implementation, correctness tests, type checks, and worktree-local native build.

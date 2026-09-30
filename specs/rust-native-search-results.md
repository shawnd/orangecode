# Search worker: source delivery and measurements

## Main integration verification — 2026-09-30

**Integrated and verified on Linux x64/glibc, Bun 1.4.2. Deployment remains parent-owned.**
The eleven files in the ownership manifest below were integrated into
`/home/shawn/code/opencode`; all ten source/test/benchmark files are byte-identical
to the final source identity below. This report additionally records main-checkout
verification. The source worktree was not modified.

The only additional integration file is `packages/opencode/script/build.ts`:
four added lines declare the virtual `opencode-fff-worker.ts` entry, import
`../core/src/filesystem/fff.worker.ts` through `Bun.build.files`, include the
entrypoint, and define `OPENCODE_FFF_WORKER_PATH` using
`JSON.stringify(bunfsRoot + fffWorkerPath)`. Existing `FFF_LIBC`, native package
embedding, other workers/defines, and the concurrent native-reminders
`nativeArtifacts(item)` plugin/API are preserved. No custom search Rust/ABI or
native-diff prototype infrastructure was integrated.

### Main checks

- `bun typecheck` from **both** `packages/core` and `packages/opencode`: pass.
- Core default routing: `bun test test/filesystem/fff-worker.test.ts test/filesystem/search.test.ts test/tool-edit.test.ts test/tool-apply-patch.test.ts`: **57 pass, 540 assertions**.
- Core opt-in: `OPENCODE_EXPERIMENTAL_FFF_WORKER=1 bun test test/filesystem/fff-worker.test.ts test/filesystem/search.test.ts test/tool-edit.test.ts test/tool-apply-patch.test.ts test/util/diff.test.ts`: **61 pass, 2,735 assertions**.
- Core default diff: `bun test test/util/diff.test.ts`: **4 pass, 2,195 assertions**.
- Core disable precedence: `OPENCODE_DISABLE_FFF=1 OPENCODE_EXPERIMENTAL_FFF_WORKER=1 bun test test/filesystem/search.test.ts -t 'selected backend'`: **1 pass**.
- Legacy fuzzy/edit from opencode: `bun test test/tool/edit.test.ts test/tool/edit-fuzzy.test.ts`: **46 pass, 12,884 assertions**.
- Prettier checks on all ten delivered TS files plus `script/build.ts`, and targeted `git diff --check`: pass.
- Source smoke from Core: `bun bench/native-search.ts smoke /tmp/opencode/search-integration/fixture`: pass with actual source worker path, `backend: "fff-worker"`, `destroyed: true`, `started: false`. Fixture `smoke.txt` contains `é🙂 native_worker_needle\n`.

### Hermetic compiled helper and real production route

Temporary, reusable verification scripts (outside the repository):

```text
/tmp/opencode/search-integration/build-smoke.ts
/tmp/opencode/search-integration/sandbox.ts
/tmp/opencode/search-integration/controller.mjs
/tmp/opencode/search-integration/fixture/smoke.txt
```

Run `bun /tmp/opencode/search-integration/build-smoke.ts`, then
`bun /tmp/opencode/search-integration/sandbox.ts`. The helper builds the existing
benchmark smoke entry with **the same virtual worker filename/import/entrypoint
and quoted define arrangement as production**, retaining FFF_LIBC. Bubblewrap
exposes the executable, fixture, and `/usr` system tools/libraries, with private
HOME/XDG/tmp/work, no source/worktrees/node_modules, and an isolated network
namespace. An external `timeout` enforces 20 seconds (75 for production).
`SEARCH_SMOKE_COMPILED=1` is set. Filename and grep results pass; the exact runtime
worker path is **`file:///$bunfs/root/opencode-fff-worker.js`**, backend is
**`fff-worker`**, and native disposal acknowledgement plus worker closure yield
**`destroyed: true`, `started: false`**. Fallback cannot satisfy these assertions.

Run `bun /tmp/opencode/search-integration/sandbox.ts production worker` and
`bun /tmp/opencode/search-integration/sandbox.ts production direct` against the
verified production snapshot below. Both pass. The sandbox controller uses a
loopback-only deterministic OpenAI-compatible provider, launches the **real
production `opencode serve` executable**, creates a real `/api/session`, and
verifies two provider turns, successful Core `read`, `edit`, and `apply_patch`,
settlement to idle, actual changed file contents, and fixture content returned
to the model. It then calls **`/api/fs/find?query=smoke.txt`** and verifies the
returned file. `/proc` confirms an **`fff` worker thread only with opt-in**.
Both modes map the embedded FFF library with SHA-256
`977a96fc9911edd8cabacb098e90229c6a2dde7384f3291e5beccaf1ee93fef5`, matching the
installed `@ff-labs/fff-bin-linux-x64-gnu@0.9.4` library; Bun extracts it to
`/tmp/.bun-1000-ce78de25a2553a8.so`. FFF availability/fallback warnings are rejected.
The controller asserts that source/worktree/node_modules paths are inaccessible.
The final snapshot passed both production modes and the helper smoke was rerun.

This is filesystem **find** worker wiring evidence plus real Session filesystem
read/edit/patch evidence. Core's existing `grep`/`glob` tools directly use Ripgrep;
they were not rerouted or presented as production FFF grep evidence. Native grep
and disposal acknowledgement are covered by the hermetic compiled helper and
source lifecycle/parity suite. No production shutdown-ack introspection was added.

### Production artifact handoff

The mandated command from `packages/opencode` passed:

```sh
bun run script/build.ts --single --skip-install --skip-embed-web-ui
```

Build output explicitly included `native reminders: linux-x64 glibc` and a
successful Cargo release build. Native-reminders runtime semantics were not
retested by this search integration task.

- Build path: `/home/shawn/code/opencode/packages/opencode/dist/opencode-linux-x64/bin/opencode`
- Verified, uniquely retained snapshot: **`/tmp/opencode/search-integration/opencode-verified`**
- Version: **`0.0.0-shawnd-202609300744`**
- SHA-256: **`cc5214de9823c3eb732c89d666d6d686bc0af6318da871d718043a7c0a34f298`**

A concurrent build replaced an earlier `dist` executable during verification
(0740/0741 versions). The mandated build was repeated and immediately copied to
the unique snapshot above; both hashes matched, and **both hermetic production
checks were repeated against that retained snapshot**. Parent should use that
hash-verified snapshot or rebuild/reverify if current `dist` has changed.
At the final check `dist` had again been replaced: it reported the same 0744
version but SHA-256 `d021875a39773d5372b1cb81dd547d71e3d352fad2f2a293898a700261422155`.
That different executable is **not** the artifact verified by this task; the
retained snapshot still has the `cc5214...` hash above. A version string alone
does not identify the verified build.

No commits, staging, stashing, resetting, checkout, or deployment were performed.
Other OS/libc/CPU targets and Bun 1.3.14 remain unverified; the worker remains
explicitly opt-in because the earlier large-page latency gate did not pass.

## Status and decision

Source implementation is complete on **`native-search`**, in **`/tmp/opencode/native-search`**, based on **`f47dff9ad36a778b1dbd0a99fff6a5a0b2fdf62a`**. No commits or deployment were performed. Main-checkout application files were not changed.

- **Go for source integration of the gated configuration:** direct native FFF is now the default; the worker is explicitly opt-in. Default-facade latency and bounded memory checks pass on the measured target, preserving native search rather than substituting ripgrep. The ripgrep directory-materialization improvement and availability fallback remain enabled.
- **No-go for automatic worker enablement:** large distinct-line pages still fail the worker latency gate across the tested transport alternatives. The bounded memory follow-up found no incremental worker leak trend, but does not erase the latency finding. Hermetic compiled verification and final release gating remain parent-owned; this is not a claim that compiled delivery is already rollout-safe.
- **No thread-budget default change.** The limited `maxThreads` experiments showed workload/run-dependent benefits, not a consistent replacement for fff's default. The shipped facade options do not expose it; the benchmark forwards an experimental options object to the existing engine for measurement only.
- Retains **`@ff-labs/fff-bun@0.9.4`**. There is no new Rust crate, C ABI, native binding, dependency, or search algorithm.

## Delivered behavior

- **`OPENCODE_EXPERIMENTAL_FFF_WORKER=1` or `true` opts in to the worker.** Unset, `0`, `false`, or other values retain direct native FFF. `OPENCODE_DISABLE_FFF` takes precedence in normal service routing; Node still uses ripgrep. The flag is read when a Location's facade is created. The earlier short flag spelling was renamed before integration and is not supported.
- The Bun `#fff` facade creates an inert client in either mode. Direct mode dynamically imports FFF on first use and owns the native picker on the caller isolate. Worker mode starts one Location-owned worker, which alone imports/probes/creates/calls/destroys its own picker. Direct FFI remains synchronous and can block the caller; no Promise wrapper is described as native preemption.
- `Fff.create(opts)` follows the runtime opt-in. `Fff.createWorker(opts)` and `Fff.createDirect(opts)` explicitly select a backend for benchmarks/smoke verification. The direct facade shares initialization independently of individual callers, logically cancels initialization/scan waiters, rejects pending callers on disposal, and waits for every admitted native operation/scan poll before native destruction. Late initialization after scope interruption is cleaned up.
- Requests carry monotonically increasing safe-integer IDs. One RPC executes at a time; at most **32 RPCs including the active request** are admitted. Excess callers wait on interruptible parent-side admission. Cancellation removes queued/waiting requests and immediately detaches active callers; the active native slot remains occupied until its response.
- Disposal stops admission, rejects callers, waits for active native return, invokes `FileFinder.destroy()` in the owning worker, receives the disposal acknowledgement, terminates the idle worker, and waits for its close event. Unexpected close/disposal errors are not reported as successful cleanup.
- Location finalizers own the client. Failed initialization/startup releases the failed worker and lazily builds the actual ripgrep implementation. Node still explicitly selects ripgrep. Query errors, defects, and interruption do not trigger fallback.
- Preserves `aiMode`, disabled mmap/content indexing, watch behavior, one-page grep, the 1,500 ms soft grep budget, query concatenation, trimming, ranking/stable ties, limits/defaults, relative paths, UTF-8 byte ranges/offsets, and UTF-16 2,000-code-unit truncation. No file-offset cursor slicing.
- Byte-to-text conversion runs with the selected native backend, through one shared formatter. Core schema construction yields between 128-match batches on large pages and checks cancellation between batches. This is result materialization, not slicing native grep or changing result completeness.
- Ripgrep's append-only directory set is materialized on consumption only when its size has changed. Partial scan results remain observable; first queries do not gain a full-scan barrier.

**Limits:** synchronous native calls cannot be preempted. Filename queries have no verified native cancellation; grep's budget is soft. Disposal has no hard deadline. A Bun Worker is not native crash isolation. Existing fff regex fallback, single-page completeness, and combined path/query grammar remain unchanged.

## Ownership manifest

Modified owned files:

```text
packages/core/src/filesystem/fff.bun.ts
packages/core/src/filesystem/fff.node.ts
packages/core/src/filesystem/search.ts
packages/core/test/filesystem/search.test.ts
packages/opencode/script/bench-search.ts
```

New owned files (include these when exporting the patch):

```text
packages/core/src/filesystem/fff-types.ts
packages/core/src/filesystem/fff-client.ts
packages/core/src/filesystem/fff.worker.ts
packages/core/test/filesystem/fff-worker.test.ts
packages/core/bench/native-search.ts
specs/rust-native-search-results.md
```

**Excluded shared input:** `specs/rust-native-acceleration.md`, copied with apply_patch and verified byte-identical to the main-checkout design. SHA-256: `2a1a290ba8957084bc25df706c08fa9ca2ea9748b13b87e73e7396689f892da8`.

**Borrowed infrastructure:** none supplied or modified. Worktree-local `node_modules`, synthetic fixtures, Node facade bundle, and raw measurements under ignored `packages/core/dist/native-search/` are artifacts, not integration files. Manifests, lockfiles, build scripts, TUI, Schema, Protocol, Server, and shared native infrastructure were not edited.

The parent explicitly approved `packages/opencode/script/bench-search.ts` as an additional owned delivery file. During the benchmark-only acceptance follow-up, all six production files were kept byte-identical to the reviewed snapshot, and no reviewer polling was performed. After the parent reported a clean independent review and authorized production follow-up, the opt-in/direct-default change was implemented within the existing ownership set. The hashes below identify the current delivery.

## Verification

Worktree root: `bun install --frozen-lockfile` succeeded without tracked manifest/lockfile changes. From `packages/opencode`, `import.meta.resolve("@opencode-ai/core/filesystem/search")` resolved to this worktree, not the main checkout.

From `packages/core`:

```sh
bun typecheck
bun test test/filesystem/fff-worker.test.ts test/filesystem/search.test.ts test/tool-edit.test.ts test/tool-apply-patch.test.ts
OPENCODE_DISABLE_FFF=1 bun test test/filesystem/search.test.ts -t 'selected backend'
bunx prettier --check src/filesystem/search.ts src/filesystem/fff.bun.ts src/filesystem/fff.node.ts src/filesystem/fff-client.ts src/filesystem/fff-types.ts src/filesystem/fff.worker.ts test/filesystem/search.test.ts test/filesystem/fff-worker.test.ts bench/native-search.ts
```

Current results: **Core and opencode typechecks pass; 57 tests pass, 540 assertions, zero failures, both normally and with worker opt-in enabled; disabled-plus-opt-in subprocess 1 pass; formatting passes.** Tests exercise real native/source workers and real ripgrep, not a mocked native kernel. Coverage includes raw SDK/direct facade/worker output parity after scan readiness; all four filename/directory/glob/mixed operations; multiple limits/defaults; Unicode/spaces/hidden/ignored paths; regex error/fallback behavior; many matches in one file; byte ranges, long-line truncation and materialization parity; watcher freshness in both native backends; independent pickers; >32 admitted worker callers; active/queued/waiting cancellation; interruption preservation; initialization and in-flight disposal; repeated open/close; physically missing native-package import, missing/throwing worker module, and both native-create fallback paths; concurrent fallback cohorts; query errors not falling back; large-page formatting cancellation. Fresh-process routing tests cover unset/0/false/invalid/1/true. Direct-specific tests cover pre-admission cancellation, shared initialization, interrupted Effect Exits, late-init destruction, idempotent failed/unused disposal, and reentrant shutdown after the SDK has captured a native handle but before FFI argument evaluation finishes. Native direct execution remains synchronous; the responsive active-call interruption guarantee applies only to the worker.

Additional gated-routing commands, from `packages/core`:

```sh
OPENCODE_EXPERIMENTAL_FFF_WORKER=1 bun test test/filesystem/fff-worker.test.ts test/filesystem/search.test.ts test/tool-edit.test.ts test/tool-apply-patch.test.ts
OPENCODE_DISABLE_FFF=1 OPENCODE_EXPERIMENTAL_FFF_WORKER=1 bun test test/filesystem/search.test.ts -t 'selected backend'
```

Node portable-facade smoke, from `packages/core`:

```sh
bun build src/filesystem/fff.node.ts --target=node --outdir=dist/native-search/node
node --input-type=module -e 'import {Fff} from "./dist/native-search/node/fff.node.js"; if (Fff.available()) throw Error("unexpected availability"); console.log("node facade: unavailable, no native imports")'
```

Passed on Node **v25.9.0**; the current bundle contains two portable modules, approximately 1.22 KiB, with no Bun-native imports. `create`, `createDirect`, and `createWorker` all explicitly report unavailable on Node. This is not the native executable packaging smoke.

From `packages/opencode`, **`bun typecheck` now passes**. The parent-approved benchmark edit replaces the synchronous raw facade calls with direct `FileFinder`, resolving the three introduced type errors. Running the whole script also exposed its pre-existing V1-runtime/V2-service mismatch (`Service not found: @opencode/v2/FileSystem`): the legacy AppRuntime did not provide the imported V2 service. The approved benchmark now constructs a scoped Core FileSystem/Location graph, injects only the client factory to await native scan readiness, and disposes its runtime normally. Both raw and service sections require scan readiness before reporting warm measurements. Production service code was not changed.

The complete approved script passed under a 45-second external watchdog with isolated HOME/XDG folders at `packages/core/dist/native-search/compat/{home,config,data,cache,state}` and `OPENCODE_DISABLE_MODELS_FETCH=1`. It returned nonempty raw and service results (e.g. 5 `FileFinder` matches in each, 42 `package.json` results in each), completed glob queries, and printed `[Search] disposed location runtime`. The raw filename baseline is deliberately `fileSearch`; the service's default `find` is mixed search, so those operations are not asserted to have identical rankings/counts. This source benchmark run is not a substitute for compiled production smoke.

During development the synthetic fixture initially used invalid `.ts` contents under `dist`, which the package's broad typecheck picked up. The benchmark generator was corrected to generate `.txt` files and its own fixtures regenerated; the final Core check above passes. This was a benchmark artifact mistake, not a baseline failure.

Physically missing native-package import is now verified in both native modes: fresh `bun --no-install` subprocesses load the real facade/client/worker from an isolated directory without node_modules, share only the canonical error/formatter module, and verify real ripgrep results after import failure. No fake native module or main-checkout dependency mutation is involved. Native create failure and missing/failed worker startup are also verified. Not verified: a corrupted/ABI-incompatible existing native library, Bun **1.3.14**, other OS/libc/CPU targets, or hermetic compiled worker execution. No compiled build infrastructure was borrowed.

### Independent acceptance addendum follow-up

Read and enforced the search requirements in `/home/shawn/code/opencode/specs/rust-native-verification.md`. That parent-owned document was not edited or copied into this patch.

Two concrete lifecycle corrections followed:

1. Bun 1.4.2 does **not** expose `WorkerGlobalScope.close()`. Removed the invalid worker `self.close()` call. The worker sends an acknowledgement after native destruction; the parent then calls `terminate()` on the idle worker and observes its `close` event. `terminate()` is never awaited as though it returned a termination promise.
2. Disposal now preserves the internal init completion callbacks rather than detaching them as though initialization belonged to an individual caller. A picker created after scope closure still records its native initialization and is destroyed by the control path. Pending RPC/disposal work explicitly refs the worker; an idle ready worker is unreffed. This does not depend on Bun's default reference mode or interpret process exit as cleanup.

The source worker's successful init DTO now includes `{ backend: "fff-worker", workerPath: import.meta.url }`. Its successful dispose DTO includes `{ destroyed: owned?.isDestroyed ?? false }`, evaluated **after** `owned.destroy()` returns. Client diagnostics expose this evidence. They distinguish a dead worker with no acknowledged destruction from a successfully destroyed picker. Disposal does not wait for an impossible ack from a worker that has already exited; a failure during pending disposal settles it with a transport error.

New deterministic tests use a temporary wrapper around the **real source worker**. The wrapper gates request/result delivery and records successful init/dispose responses; it does not replace FileFinder, native methods, or result values. Holding a real grep response after computation tests the active execution slot without falsely claiming to pause Rust inside FFI.

Verified:

- Production `makeFff` registers its Location finalizer before any query initializes native state. Interrupting the owning Effect scope during held initialization leaves cleanup pending until the late picker is created and explicitly destroyed.
- Concurrent first callers share one init. Interrupting the first retains an interrupted Effect Exit, while the other caller and subsequent native queries succeed.
- Actual Effect fibers interrupted during initialization, blocked admission, queued execution, and active response delivery all retain interrupted Exits. Queued interruption admits the next waiter; active interruption does not release the native/RPC slot early. These calls do not resolve as fallback or empty success.
- Worker error/exit with a full starting queue, both before and during disposal, settles every caller, admission waiter, and disposal waiter. Dead workers require no successful destruction acknowledgement.
- Real synchronous `postMessage` structured-clone getter failures settle a full queued/admission set. A reentrant shutdown starting during that failure also completes through the separate disposal control path.
- Full starting and active queues are each exercised in isolated subprocesses under **`timeout --signal=KILL 15s`**. Both subprocesses record exactly one successful init and one successful disposal in a marker file, verify `destroyed: true`, observe worker closure, and print `FFF_DESTROY_ACK_ONCE`. The outer test verifies the marker independently; zero exit status alone is insufficient.

Focused watchdog command, from `packages/core`:

```sh
bun test test/filesystem/fff-worker.test.ts -t 'watchdog proves'
```

Result: **2 pass**, each with its own external watchdog and destruction marker. All readiness-dependent tests/benchmark branches now explicitly require `waitForScan(...) === true`, including cold-start and cleanup probes. The cancellation benchmark checks the exact explicit abort reason rather than accepting any rejection as cancellation.

Post-hardening performance sanity check (same affinity/options, fresh processes, 30 iterations):

```sh
for backend in direct worker; do
  taskset -c 16-31 bun bench/native-search.ts run "$backend" 100000 grep 0 1 30
done
taskset -c 16-31 bun bench/native-search.ts cycles worker 100000 grep 0 1 10
```

Direct/worker median latency **77.111/76.212 ms**, p95 **85.011/92.663 ms**; caller lag p95 **86.735/1.080 ms**, max **88.256/6.133 ms**. Worker output explicitly identified `fff-worker`, the actual source `fff.worker.ts` URL, `destroyed: true`, and `started: false` after cleanup. Ten explicitly aborted cleanup cycles measured settlement median **0.043 ms**, p95/max **0.196 ms**, with acknowledged destruction on every cycle. Raw output: `dist/native-search/lifecycle-hardening-{grep.jsonl,cycles.json}`. The broader table below predates this lifecycle-only hardening; the no-go findings for large payload latency and retained memory remain in force.

## Benchmark environment and method

- Linux x64, `7.2.5-3-omarchy`, glibc **2.44**; AMD Ryzen 9 5950X, 16 cores / 32 logical CPUs, boost disabled as reported by `lscpu`.
- Bun **1.4.2** (`744846f84`), Rust **1.96.0** installed but not used to build this search track. Native code is the existing installed fff 0.9.4 platform artifact; no new compiler profile or native flags.
- Source-mode fresh subprocesses per variant. No model/network requests in the benchmark. Four warmup queries, then the recorded iteration count. `waitForScan(60_000)` before stable comparisons. Native frecency/history paths omitted for isolated, untrained pickers. Watch/indexing options match production.
- Synthetic seed **sequential-v1**: 10,000 or 100,000 files, 100 files/directory, each 1,095 UTF-8 bytes; Unicode prefix plus a repeated source-like line. Fixtures have their own Git repository. Repository measurements use this worktree and its ignores. Filesystem/page caches are warm after warmup; these are not uncached disk-throughput claims.
- Filename query `component`, page size 100. Grep query `missing_unique_token_xyz`, regex, 1,500 ms budget, page size 50. That string occurs in the benchmark source itself for the repository dataset, so repository grep has a small nonempty result. Payload stress uses `needle` and requests page size 10,000, preserving whatever one page the engine returns.
- Latency includes native work, conversion, worker roundtrip when used, and Core schema materialization for grep. Filename timing is the raw filename facade, not an end-to-end tool/TUI timing. Caller delay uses a 1 ms timer, subtracting its expected interval; each measured request yields before the next. Worker timer samples are more numerous because the caller remains free during native work; max lag is therefore reported too.
- `payloadBytes` is the **JSON UTF-8 size proxy** of returned DTOs, not an assertion about Bun's internal structured-clone encoding. RSS is process-level (including native memory); `process.resourceUsage().maxRSS` is in KiB, `process.memoryUsage().rss` in bytes.
- Final comparison below uses **`taskset -c 16-31`**, 60 iterations (payload: 40), to reduce scheduler variance. Earlier unpinned runs are retained separately and showed more p95 variance. Affinity is a benchmark setting, not a shipped runtime/thread-budget setting.

### Reproduction commands

All from `packages/core`:

```sh
bun bench/native-search.ts prepare worker 10000
bun bench/native-search.ts prepare worker 100000

for dataset in 10000 100000 repo; do
  for op in file grep; do
    for backend in direct worker; do
      taskset -c 16-31 bun bench/native-search.ts run "$backend" "$dataset" "$op" 0 1 60
    done
  done
done

for backend in direct worker; do
  taskset -c 16-31 bun bench/native-search.ts run "$backend" 10000 payload 0 1 40
done

for dataset in 10000 100000; do
  for backend in baseline optimized; do
    taskset -c 16-31 bun bench/native-search.ts allocations "$backend" "$dataset" file 0 1 5
  done
done

# Independent concurrency/thread-budget experiment (unpinned):
for threads in 0 1 2 4; do
  bun bench/native-search.ts run worker 100000 file "$threads" 4 60
done
for threads in 4 0 4 0; do
  bun bench/native-search.ts run worker 100000 file "$threads" 4 100
done

# Separate multi-Location, cold-start and cleanup probes:
for backend in direct worker; do
  bun bench/native-search.ts run "$backend" 100000 grep 0 4 30
  bun bench/native-search.ts cold "$backend" 100000
  bun bench/native-search.ts cycles "$backend" 100000 grep 0 1 80
done
```

The entrypoint takes `mode backend dataset operation maxThreads locations iterations`. `cycles worker` explicitly aborts a real query after 5 ms, measures caller settlement, then waits for clean native disposal/worker close. It does not claim that Rust stops at abort. Generated data/output stays under ignored `dist/native-search`.

### Final latency and caller responsiveness

Times in ms; each cell is **direct / worker**.

| Dataset / operation | Median request | p95 request | p95 caller lag | Max caller lag |
| --- | ---: | ---: | ---: | ---: |
| 10k filename | 1.259 / 1.770 | 1.910 / 2.687 | 2.008 / 0.283 | 2.470 / 0.767 |
| 10k grep | 9.913 / 9.965 | 15.892 / 15.558 | 15.980 / 1.032 | 33.873 / 4.757 |
| 100k filename | 9.540 / 10.063 | 13.841 / 15.156 | 13.939 / 0.699 | 14.907 / 7.754 |
| 100k grep | 79.048 / 84.899 | 90.781 / 107.321 | 91.191 / 1.221 | 106.197 / 13.544 |
| Repository filename | 1.347 / 1.844 | 1.845 / 3.083 | 1.936 / 0.325 | 3.390 / 1.713 |
| Repository grep | 7.016 / 6.723 | 9.696 / 12.271 | 9.791 / 0.555 | 34.237 / 1.647 |
| 6.6 MB grep page | 126.558 / 163.012 | 143.194 / 205.537 | 143.322 / 1.044 | 146.673 / 14.999 |

**Interpretation:** caller responsiveness passes the stated p95 <20 ms / no routine >100 ms objective in this final series, including large pages. 100k grep request median rises 7.4%, p95 18.2%, within the search 20% allowance. The large page misses latency allowance (+28.8% median, +43.5% p95). Repository grep p95 misses the +2 ms allowance by about 0.575 ms despite a lower median; unpinned repeats varied. Do not claim every latency gate passed.

Large-page materialization itself: direct median/p95 **60.512/76.696 ms**, worker caller **61.726/75.618 ms** total across yielded batches. Batching changes scheduling, not total validation cost. Filename payloads were approximately 41–44 KiB; synthetic no-match grep 2 bytes; repository grep approximately 859 bytes; stress page **6,607,891 bytes**. A text-interning transfer experiment was discarded after inconsistent results. `smol: true` was also rejected: it increased large-page latency; final workers use Bun's default heap configuration.

For the final 100k grep series, ready time (construction + import + index readiness) was **161.4/174.4 ms**, first ready query **87.0/91.5 ms**, idle RSS **130.8/133.7 MB**, active RSS **171.4/174.3 MB**, peak RSS **167,344/170,168 KiB**, direct/worker. The facade's sub-ms construction timing is not worker-startup timing. Separate fresh-process cold partial-query probe measured **14.2/71.4 ms**, both with zero early results; readiness **165.0/222.6 ms**. Partial results remain intentional.

### Concurrent Locations, cancellation, and retained memory

Unpinned four-independent-picker 100k grep: direct/worker request median **229.6/274.4 ms**, p95 **344.8/320.8 ms**; caller p95 **362.1/1.70 ms**, max **371.5/7.80 ms**. These are independent indexes over identical fixture data, sharing OS file cache, rather than a cross-Location native handle.

An 80-cycle worker probe measured abort settlement median **0.067 ms**, p95 **0.105 ms**, max **0.444 ms**. Each cycle waited for native disposal and actual worker close. Earlier worker/direct 80-cycle RSS series both grew from roughly 90–100 MB to a broad approximately **1.0–1.25 GB** late-run range. The worker's final closed RSS was **1,159 MB**, direct **1,176 MB**. This argues against claiming that the worker alone duplicates/leaks an index, but does **not** establish a strict long-run memory plateau or identify the retaining allocator. Treat retained native/runtime memory as a remaining release concern. Those series preceded the benchmark's additional service-module import used for batched materialization, so their absolute initial RSS should not be mixed with the final single-Location table.

### Independent allocation and maxThreads findings

Ripgrep callback **microbenchmark**, excluding filesystem subprocess work and Effect overhead:

| Files | Rebuild-per-entry median / p95 | Materialize-on-consumption median / p95 | References copied, old / new |
| --- | ---: | ---: | ---: |
| 10k | 37.208 / 41.433 ms | 6.996 / 8.197 ms | 5,015,000 / 1,001 |
| 100k | 2,886.579 / 2,952.019 ms | 61.478 / 70.382 ms | 500,150,000 / 10,001 |

At 100k, peak process RSS was **370,332 / 160,116 KiB**. This demonstrates the repeated-array-copy cost, not a 47x end-to-end search claim. Service tests verify actual fallback directory results with the optimized implementation.

Four independent 100k filename pickers, first 60-query run: `maxThreads` 0/1/2/4 median **27.97/48.07/30.40/22.21 ms**, p95 **44.62/66.74/38.06/31.04 ms**. Reversed 100-query repeats varied: 4 threads median/p95 **28.99/54.53**, then default **26.08/52.07**; 4 threads **24.69/37.14**, then default **27.70/39.90**. Keep default selection; do not impose four threads based on this machine alone. Grep has no corresponding option and was not altered.

Raw worktree-local output: `dist/native-search/{accepted-runs,accepted-payload,accepted-allocations,final-runs,final-extra,final-threads,runs}.jsonl` and `cycles-{direct,worker}.json`. Exploratory outputs may precede the final materialization batching/default-heap decisions; the final table is the `accepted-*` series. The filename does not imply all acceptance gates passed.

## Integration requests

1. **Parent:** add the worker to the **existing main build**, preserving its native-reminders plugin and other infrastructure. No native-diff plugin, crate, or shared build helper is required by search. Exact source entry: **`packages/core/src/filesystem/fff.worker.ts`**. Preserve the agreed virtual `opencode-fff-worker.ts` entry importing `../core/src/filesystem/fff.worker.ts` relative to the opencode build root, and add it to Bun's entrypoints. Define **`OPENCODE_FFF_WORKER_PATH`** to its verified emitted embedded path (`/$bunfs/root/opencode-fff-worker.ts` or the target's `B:/~BUN/root/` equivalent, subject to actual emitted-path verification). Preserve `FFF_LIBC` and existing fff 0.9.4 platform embedding. Every worker request/response DTO is unchanged. Refresh `fff.bun.ts`, `fff.node.ts`, `fff-types.ts`, and `fff.worker.ts` together: only the formatter moved to the shared module, and factory routing is direct by default. **Positive worker smoke must call `Fff.createWorker(...)` or set `OPENCODE_EXPERIMENTAL_FFF_WORKER=1`; otherwise `Fff.create(...)` correctly reports `fff-direct`.** No build files were edited here.
2. Parent owns the addendum's **hermetic compiled verification**, not just relocation: source checkouts/worktrees/developer libraries/node_modules inaccessible (e.g. bubblewrap), isolated HOME/XDG, network disabled, external timeout. Positive smoke must perform a successful native-only facade query and check `client.state.backend === "fff-worker"`, actual `client.state.workerPath` in the embedded namespace, and `destroyed === true` after disposal. A selected configuration, fallback results, successful loading, or process exit alone cannot pass. Also exercise real production tool/search wiring. Source tests do not prove embedding. Bun 1.3.14 and additional platforms remain unverified.
3. Include the newly approved `packages/opencode/script/bench-search.ts` in delivery. Its raw baseline, Core runtime wiring, readiness, and scoped disposal are fixed; both package typechecks pass.
4. Review the implemented **direct-default/worker-opt-in** gate and current source checks, then perform combined sandboxed/production verification. Do not promote the repeated-text-only experiment as a general latency solution or enable the worker automatically. The allocation fix, availability fallback, and native direct default are independent of new Rust diff/fuzzy kernels. Parent owns final gating and deployment.

### Reusable worker smoke entry

Reuse **`packages/core/bench/native-search.ts`**, mode **`smoke`**, as the helper entrypoint alongside the same embedded worker entry and defines used by the production build. This mode neither creates nor probes a worktree output directory, so it can run in the parent's sandbox with source/dependencies inaccessible. Supply a fixture directory containing `smoke.txt` with `é🙂 native_worker_needle` followed by a newline.

Source verification, from `packages/core`:

```sh
timeout --signal=KILL 15s bun bench/native-search.ts smoke dist/native-search/smoke
```

Passed: `FFF_WORKER_SMOKE_OK`, `backend: "fff-worker"`, native filename and grep results, `destroyed: true`, `started: false`. After compiling that entry with the worker embedded, invoke:

```sh
SEARCH_SMOKE_COMPILED=1 timeout --signal=KILL 15s /smoke/search-smoke smoke /fixtures
```

The compiled-mode check additionally requires the actual worker module URL to be in `$bunfs` or `B:/~BUN`. It explicitly uses `createWorker`, has no ripgrep fallback, requires scan readiness, and verifies destruction/closure before printing success. Parent still must run this in the hermetic sandbox and exercise production executable wiring; the source pass is not a compiled pass. This helper does not depend on discarded diff packaging.

## Acceptance follow-up: bounded memory and transport experiments

This benchmark-only phase is complete and predates the authorized opt-in implementation. Production was kept frozen throughout those experiments. Experimental worker wrappers are generated only into ignored `packages/core/dist/native-search/experiment-*.worker.mjs`; they wrap the actual source worker and use the actual scheduler/native engine. None of the experimental codecs, tuple formats, schema-decoder changes, glibc calls, or GC settings was promoted to production.

### Bounded memory result

The new `memory` mode is an external supervisor: it samples the child process's `/proc/<pid>/status` every 25 ms and kills the isolated process on its RSS or time ceiling, including while its main thread is in synchronous native code. The child also has a finite cycle count. Limits were **768 MiB / 90–100 seconds for 10k files**, **1,536 MiB / 120 seconds for 100k files**. Every run below completed its requested cycles with exit 0 and no ceiling hit. One child runs at a time, affinity CPUs 16–31; the small supervisor process is excluded from measured child RSS.

Each cycle creates an independent picker, requires `waitForScan(...) === true`, performs a real grep, destroys it, verifies destruction (and worker closure where applicable), lets lexical picker references expire, and waits 25 ms. Both natural GC and explicit `Bun.gc(true)` after each cycle were compared. No cancellation is used in this probe, so direct and worker cycles do the same completed native work.

Decimal MB; closed-RSS median is the last 50 cycles. Slopes are least-squares over the last 50 closed-RSS samples in MB/cycle, not lifetime allocation counts.

| Corpus / cycles / GC | Closed median direct / worker | Late slope direct / worker | External peak direct / worker |
| --- | ---: | ---: | ---: |
| 10k / 200 / explicit | 141.7 / 171.3 MB | +0.042 / +0.0036 | 148.2 / 183.7 MB |
| 10k / 500 / natural | 191.9 / 212.7 MB | +0.056 / -0.099 | 199.2 / 229.8 MB |
| 100k / 200 / explicit | 819.9 / 856.9 MB | +1.432 / -0.254 | 928.8 / 950.0 MB |
| 100k / 200 / natural | 947.1 / 756.0 MB | -0.446 / -0.600 | 1,048.1 / 870.7 MB |

For the 500-cycle natural-GC 10k run, the longer last-100 slopes were **+0.0389 MB/cycle direct and +0.0032 MB/cycle worker**: the worker is in a stable late window with about **20.7 MB** incremental closed RSS. For 100k explicit-GC runs the last-100 worker slope was **-0.045 MB/cycle**. There was no one-thread-per-cycle accumulation: late 10k runs had 50 threads in both processes; 100k runs stayed within roughly 46–57 threads. Worker indexes were acknowledged destroyed on every cycle.

The existing platform fff library dynamically imports glibc `malloc/calloc/realloc/free` (`readelf -d` / `nm -D`). A **benchmark-only**, post-series `malloc_trim(0)` diagnostic was called through libc after 5 seconds idle and a final explicit JS GC. For the 100k explicit-GC runs, idle+GC RSS was **767.1/809.7 MB**, dropping to **469.3/488.5 MB** after trim, direct/worker. Natural-GC runs dropped from **973.5/740.2 MB** to **604.1/505.0 MB**. Final JS GC alone made no visible reduction in those samples. This demonstrates hundreds of MB of already-freed allocator pages, not hundreds of MB of live worker-owned indexes. It does not identify every retained allocation or prove universal leak freedom.

**Decision:** the previously unclear repeated-use memory gate is supported on Linux x64 glibc/Bun 1.4.2 for these bounded 10k/100k workloads. No incremental worker leak trend was observed. Large absolute retention and allocator oscillation also occur directly. No production `malloc_trim`, forced GC, allocator environment tuning, indexing option, or thread-budget change is proposed.

Commands from `packages/core`:

```sh
for backend in direct worker; do
  SEARCH_RSS_MB=768 SEARCH_SECONDS=90 taskset -c 16-31 bun bench/native-search.ts memory "$backend" 10000 grep 0 1 200
  SEARCH_RSS_MB=1536 SEARCH_SECONDS=120 taskset -c 16-31 bun bench/native-search.ts memory "$backend" 100000 grep 0 1 200
  SEARCH_GC=off SEARCH_RSS_MB=1536 SEARCH_SECONDS=120 taskset -c 16-31 bun bench/native-search.ts memory "$backend" 100000 grep 0 1 200
  SEARCH_GC=off SEARCH_RSS_MB=768 SEARCH_SECONDS=100 taskset -c 16-31 bun bench/native-search.ts memory "$backend" 10000 grep 0 1 500
done
```

Raw summaries: `dist/native-search/memory-{10k-gc,100k-gc,natural-gc}.jsonl`. Full per-cycle data is in the timestamped `memory-*.json` files named by each summary. The 10k/200 series was originally printed inline in its JSONL instead of a separate series file.

### Transfer/materialization result: no general latency winner

Tested ordinary object-graph clone; UTF-8 JSON in transferable ArrayBuffer; JSON string clone; `bun:jsc` serialized SharedArrayBuffer; copied-and-transferred JSC ArrayBuffer; compact tuple rows with ordinary clone; and JSC/JSON encoding of those rows. Shared JSC buffers were immutable experiment payloads, not native input buffers. No new dependency or ABI was created.

Separately tested a cached `Schema.decodeUnknownSync(Schema.Array(Match))` on 128-row batches instead of repeated `RelativePath.make`, `Entry.make`, and `Match.make`, plus a public `Schema.is` guard variant. Both retain validation and yielding; invalid line 0, negative offsets, and Infinity are rejected by both the frozen implementation and the candidates. Match/Entry are plain Schema structs, not class instances. Native-page materialization equality is checked in full.

Every codec was checked against the **exact same native page**, sent separately as the ordinary-clone oracle before timing, with full deep equality (not just a hash). Additional roundtrips cover Unicode/combining characters, lone surrogates including a truncated astral pair, BOM, NUL/CRLF, quotes/backslashes, empty and multiple submatches, offsets above 32 bits, ranges beyond the truncated displayed text, and ordering. Subsequent timed responses still come from real FFF queries. Both source backend evidence and destruction acknowledgement are checked.

The first 6.6 MB fixture repeats the same source-like line. To avoid accepting a string-deduplication artifact, a second **`10000u`** fixture prefixes each file with its own six-digit index: 10,000 files × 1,102 bytes, seed `sequential-v1-unique`, and distinct returned lines. Its actual page is **6,617,891 JSON UTF-8 bytes**, compared with **6,607,891** for repeated text. Both return 10,000 matches. The `prepare` command accepts the `u` suffix only for this isolated variant.

Representative repeated and unique series, 60 measured queries after warmup, fresh processes, CPUs 16–31; each experiment supervised at **1,024 MiB / 45 seconds**. All completed below the ceilings. Values are median / p95 latency in ms:

| Pipeline | Repeated text | Unique text |
| --- | ---: | ---: |
| Original direct baseline | 98.418 / 124.151 | 95.021 / 108.327 |
| Worker object clone + cached batch decoder | 118.420 / 139.005 | 151.179 / 165.851 |
| Worker tuple clone + cached batch decoder | 106.510 / 126.288 | 138.008 / 146.452 |
| Worker JSC transferred tuples + cached batch decoder | 103.803 / 116.888 | 134.582 / 158.413 |
| Worker UTF-8 JSON buffer + cached batch decoder | 125.854 / 148.868 | 126.394 / 146.247 |
| Worker UTF-8 JSON tuples + cached batch decoder | 120.413 / 145.584 | 122.255 / 137.523 |

Tuple clone + batched decoding passes the repeated-text gate, but **fails the unique-text gate by a wide margin**. The best measured unique-text median, JSON tuples + batched decoder, is still **28.7% slower** than original direct, with **27.0% p95 regression**, exceeding 20%. The public-schema-guard variants did not improve this: unique JSON tuples measured **131.760/144.082 ms** and ordinary tuples **139.609/161.160 ms**. No candidate is recommended for unconditional promotion.

The mechanism is visible in the stage timings. Ordinary graph delivery is about **30 ms** for repeated text but **64 ms** for unique text; tuples reduce that to about **13/45 ms**. Encoded ArrayBuffers reduce delivery itself below a millisecond but add encoding and decoding. JSC tuple payloads expand from approximately **1.03 MB repeated to 11.19 MB unique**. JSON tuples avoid that expansion (approximately 5.7 MB) but spend about **22 ms encoding + 14 ms decoding** on unique lines. Cached batch schema construction reduces caller materialization from approximately **45–50 ms to 34–37 ms**; the remaining transport work still exceeds the latency allowance. Caller p95 delay stays approximately **0.5–1 ms**, with bounded worst stalls in the tens of milliseconds.

An independently optimized direct pipeline with the batch decoder measured **85.072/93.541 ms** on repeated text, versus original-direct approximately **92–98 ms** median. Thus the schema improvement is a separate JS-side benefit, not evidence that transport became free or native compute became faster.

Reproduction (from `packages/core`):

```sh
bun bench/native-search.ts prepare worker 10000u
for dataset in 10000 10000u; do
  SEARCH_RSS_MB=1024 SEARCH_SECONDS=45 taskset -c 16-31 bun bench/native-search.ts bounded transfer direct "$dataset" payload 0 1 60
  for backend in clone tuples jsc-tuples json json-tuples; do
    SEARCH_MATERIALIZE=decode SEARCH_RSS_MB=1024 SEARCH_SECONDS=45 taskset -c 16-31 bun bench/native-search.ts bounded transfer "$backend" "$dataset" payload 0 1 60
  done
done
# Buffer-only alternatives retain original materialization when SEARCH_MATERIALIZE is omitted:
for backend in clone json json-string jsc-shared jsc-transfer; do
  SEARCH_RSS_MB=1024 SEARCH_SECONDS=45 taskset -c 16-31 bun bench/native-search.ts bounded transfer "$backend" 10000 payload 0 1 40
done
```

Raw outputs: `dist/native-search/transfer-{matrix,decode-matrix,tuples,repeat-unique,json-tuples,guard,parity-only}.jsonl`. `parity-only` uses one measured iteration solely to rerun exact correctness after strengthening the oracle; its timings are not performance evidence. The `bounded` supervisor wraps any benchmark subcommand and reports its observed peak/exit status. Temporary worker wrappers, corpora, logs, libc diagnostics, and compatibility HOME/XDG data are excluded from delivery artifacts.

**Experiment decision:** memory concern resolved for the measured envelopes; no broadly passing simple large-page transport fix found. The subsequent independent review was reported clean by the parent, who authorized the direct-default/opt-in implementation below. The cached batch decoder remains an unshipped experiment; even the best tested combination does not justify automatic worker routing. Hermetic compiled integration remains parent-owned.

## Final gating follow-up: default direct FFF, explicit worker opt-in

The new direct facade is lazy and asynchronous at the JS boundary, but executes the existing synchronous native calls directly. It does not replace native FFF with ripgrep to conceal the failed worker latency gate. It keeps the same Location lifetime, native options, queries, result formatting and availability fallback. Shared initialization is not canceled by one caller; disposal rejects pending callers and waits for late initialization/in-flight operations before destroying the picker. A reentrant-disposal regression test uses a real SDK option getter after the native handle has been captured, proving that destruction cannot free a handle still borrowed by the operation.

The grep formatter was moved, unchanged, into `fff-types.ts` and is reused by both modes. **There is no worker protocol/filename/define change.** Tests and benchmarks that specifically measure the worker now call `createWorker` explicitly. The approved opencode benchmark likewise explicitly selects the worker for its scoped service section while retaining raw `FileFinder` as its synchronous baseline.

Fresh-process routing checks and both-backend parity/lifecycle checks pass as listed above. Default-facade performance was measured through **`Fff.create(...)` with the worker gate disabled**, not by accidentally benchmarking only the raw SDK. The original measurements used the earlier short flag spelling; the commands below use its final `OPENCODE_EXPERIMENTAL_FFF_WORKER` spelling with the same disabled behavior. The `facade` variant records `backend: "fff-direct"` and destruction evidence, and the memory probe asserts destruction on every cycle.

Same CPU affinity and bounded fresh-process method; median / p95 ms, raw direct versus selected default facade:

| Workload | Raw direct | Default facade |
| --- | ---: | ---: |
| 10k filenames, 100 iterations | 1.263 / 2.033 | 1.464 / 2.031 |
| Repeated 6.6 MB page, 60 iterations | 114.074 / 142.200 | 108.988 / 158.016 |
| Distinct-line 6.6 MB page, 60 iterations | 114.946 / 142.042 | 105.064 / 117.588 |

All three default-path comparisons fit the search allowance (20% or 2 ms). The repeated-page p95 was 11.1% higher, not hidden or claimed as a speedup. The distinct-line default avoids the worker's large-clone regression. The synchronous native portion can still block the caller, as before; these results do not claim the worker responsiveness guarantee for direct mode.

A separate **500-cycle, natural-GC default-facade** probe on 10k files completed under the 768 MiB / 100-second supervisor limits: **192.4 MB last-50 closed-RSS median**, **198.7 MB externally observed peak**, **195.3 MB final closed RSS**, 45 late-run threads, and about **0.052 MB/cycle last-100 slope**. The earlier raw-direct control was **191.9 MB** late median with about **0.039 MB/cycle** slope. This adds no material retained-memory regression over the raw native baseline in the measured envelope. Every cycle verified native destruction.

Commands from `packages/core`:

```sh
for dataset in 10000 10000u; do
  for backend in direct facade; do
    OPENCODE_EXPERIMENTAL_FFF_WORKER=0 SEARCH_MATERIALIZE=original SEARCH_RSS_MB=1024 SEARCH_SECONDS=45 taskset -c 16-31 bun bench/native-search.ts bounded run "$backend" "$dataset" payload 0 1 60
  done
done
for backend in direct facade; do
  OPENCODE_EXPERIMENTAL_FFF_WORKER=0 SEARCH_MATERIALIZE=original SEARCH_RSS_MB=1024 SEARCH_SECONDS=45 taskset -c 16-31 bun bench/native-search.ts bounded run "$backend" 10000 file 0 1 100
done
OPENCODE_EXPERIMENTAL_FFF_WORKER=0 SEARCH_GC=off SEARCH_RSS_MB=768 SEARCH_SECONDS=100 taskset -c 16-31 bun bench/native-search.ts memory facade 10000 grep 0 1 500
```

Raw outputs: `dist/native-search/default-direct-{payload,small,memory}.jsonl`, plus the timestamped per-cycle series referenced by the memory summary. The optional worker's previous responsiveness gains remain available explicitly; its large-page regression is disclosed and is the reason it is not the default.

## Final source identity

SHA-256, relative to `packages/core` (report itself excluded):

```text
baa635f529d09b9a7a7966d654aacf15fdb32065353d85ebfd401352ccd4df86  src/filesystem/search.ts
741593ee181ed381cd45677346bfbd97278bfb87c5cf4e0565d86b63b50f8d24  src/filesystem/fff.bun.ts
61e201ac2f936571278a23209e3e7c9985c8802bdb5fe277d5a526529c0b9ed7  src/filesystem/fff.node.ts
efa3dcdbe41b6c9b8fb67a85bfb1aa9cea1174fd65e14c8c61d45812a2f2669f  src/filesystem/fff-client.ts
5b04f4b41c7c907148e6dfb559e4184cf653d87a0b6ba836f812acb677a4f3cc  src/filesystem/fff-types.ts
3f6b4e185c068248b5625aa7ea0dab91f6ba04a8f1287a76fc618add0a1c5340  src/filesystem/fff.worker.ts
b6052d74f994333274f76dd0c7817d8c79f656ceca8e4f3791f6252067591488  test/filesystem/search.test.ts
b49ee96bc5031700c75b0c4ab5ceec619f6c55da255a4406ba45b97918ed6215  test/filesystem/fff-worker.test.ts
01b4fff86e6529c076c1878b63c07903c5d2be441a1147119c4ccc1d29bb6cf0  bench/native-search.ts
724d69abb1906474827bfd7c92e88a828cf94fe38ace9fcdcc9e528a229e6abe  ../opencode/script/bench-search.ts
```

# Rust native acceleration: shared implementation design

> User steering supersedes the fuzzy implementation sections below: use an
> off-the-shelf edit-distance package, not a custom Rust or TypeScript algorithm.
> Preserve legacy matching semantics and verify package parity/performance.
> The experimental fuzzy ABI, kernel, calibration, and force-mode scaffolding are
> not required for the final fuzzy delivery. Diff/search remain separate tracks.
>
> Final integration scope: fuzzy uses `leven`; diff ships the one-pass existing
> `diff` package optimization. Native diff missed the automatic-routing gate and
> remains isolated in `/tmp/opencode/native-diff`. Its prototype infrastructure
> must not overwrite the independently developed native reminders implementation
> now present in main. Worker search remains opt-in unless its acceptance gates
> are met. The sections below document the experiment, not enabled production
> backends.

Status: implementation handoff, not an implementation or a benchmark result.

Base: `f47dff9ad36a778b1dbd0a99fff6a5a0b2fdf62a` (`f47dff9ad3`). Research environment: Linux x64, Bun 1.4.2, Rust/Cargo 1.96.0. The root manifest still declares Bun 1.3.14 and `@types/bun` 1.3.13; do not silently raise those versions.

## 1. Decision and scope

Use **one Rust `cdylib` with a versioned C ABI, loaded through `bun:ffi`**. Put it in `packages/core/native`, with independent `diff.rs` and `fuzzy.rs` kernels. Core owns the runtime adapter in `packages/core/src/native`. Do not create a new workspace package, a napi-rs addon, a second native loader, or a new search engine.

Three workstreams:

1. **Diff + shared infrastructure owner:** eliminate duplicate diff computation in Core edit/apply-patch; implement a parity-preserving native line-diff kernel; own the crate, ABI wrappers, loader, artifact build/embedding, and shared integration changes.
2. **Search owner:** move the existing Rust fff engine off the calling JS thread, preserve its search behavior, fix failed-initialization fallback, and measure targeted allocation/thread-budget improvements. This track does not add Rust code in the first delivery.
3. **Fuzzy owner:** replace the legacy full Levenshtein matrix with rolling-row TS, add the equivalent Rust UTF-16 distance kernel, and preserve legacy replacer behavior. Core's exact-edit semantics stay exact.

The useful first delivery can be optimized TS diff, optimized TS fuzzy matching, and off-thread fff even if one native kernel fails its go/no-go gate. Native is a measured acceleration backend, not a requirement to replace a faster or more faithful TS implementation.

No Protocol/Server API or Schema changes are needed. No generated client/SDK changes are needed. No TUI edits are needed for the initial search responsiveness improvement.

## 2. Repository findings that constrain the design

### Runtime and build

- Root `AGENTS.md` requires Core to remain below Server and forbids Client runtime dependencies on Core/Server. Applicable additional instructions: `packages/opencode/AGENTS.md`, `packages/opencode/test/AGENTS.md`, and `packages/core/src/tool/AGENTS.md`. Read the Effect skill before changing Effect services.
- `packages/core/package.json` already defines `#fff`: Bun -> `filesystem/fff.bun.ts`, Node -> `filesystem/fff.node.ts`, default -> Bun. Node deliberately reports fff unavailable and uses ripgrep. Preserve that explicit Node behavior.
- `@ff-labs/fff-bun@0.9.4` is already a Core and opencode dependency. Its installed `src/ffi.ts` uses `bun:ffi` (`dlopen`, pointers, explicit frees); `src/embedded.ts` uses file imports and passes the resulting `$bunfs` path directly to `dlopen`.
- fff's embedding code resolves at module initialization, and Core's current Bun facade statically imports it. Merely importing the current search graph can therefore evaluate native-package setup even before a query. Moving this dependency into a lazy worker is valuable independently of Rust compute speed.
- `packages/opencode/script/build.ts` uses `Bun.build`, `conditions: ["bun", "node"]`, `compile`, explicit worker entrypoints, `files`, and per-target defines. It installs platform variants of OpenTUI, Parcel watcher, and fff unless `--skip-install` is supplied. It defines `FFF_LIBC` as `gnu` or `musl` and uses `/$bunfs/root/` or `B:/~BUN/root/` for embedded worker paths.
- The build matrix is Linux/macOS/Windows, x64/arm64, Linux glibc/musl, plus x64 baseline variants. `--single` selects the current platform without an ABI-specific variant. Bun cross-compilation does **not** cross-compile Rust libraries.
- `packages/core/src/image/photon.ts` is another real file-import embedding precedent, for WASM. `packages/opencode/src/cli/tui/worker.ts` and the TUI command demonstrate separately embedded worker entrypoints.
- Other native dependencies include `@parcel/watcher`, `bun-pty`/`@lydell/node-pty`, OpenTUI, and photon/WASM. N-API exists in dependencies, but there is no in-repo Cargo crate or napi-rs build infrastructure to reuse. C ABI follows the closest existing Rust/Bun precedent and avoids adding Node-native support that this project currently does not require for fff.

### Diff

- `packages/core/src/tool/edit.ts` calls `diffLines(source.text, replaced)` for counts and later `createTwoFilesPatch(...)` for the patch. The latter calculates the same line diff again.
- `packages/core/src/tool/apply-patch.ts:patchFile` does the same duplicate work. Its patches are prepared before sequential mutations. Preserve approval, stale-content checks, partial-application reporting, and write ordering.
- Catalog `diff` is 8.0.2. Its installed `libesm/patch/create.js` exposes `structuredPatch` and `formatPatch`. `structuredPatch` does one `diffLines` pass, constructs hunks with default context 4, and inserts no-final-newline markers. Counts can be derived from `+` and `-` hunk lines without another diff.
- `formatPatch` mutates zero-length hunk start positions. Count before formatting and do not reuse a formatted structured-patch object.
- Equal-cost Myers paths are observable in patch bytes. A generic Rust diff crate using “Myers” is not automatically equivalent to jsdiff. The current `diff/libesm/diff/base.js` tie-breaking and edge pruning are the oracle.
- Legacy `packages/opencode/src/tool/edit.ts` also diffs, but uses normalized text for some patch calls and raw text for counts, and recalculates after formatting. **It belongs wholly to fuzzy track in this round.** Diff track must not edit it.

### Search

- `packages/core/src/filesystem/search.ts` wraps fff create/find/glob/grep in synchronous Effect work. Grep allows `timeBudgetMs: 1_500`; Rust runs synchronously on the JS caller even though it may use its own internal threads.
- fff is Location-scoped and destroyed in a finalizer. Preserve that ownership. Do not make one cross-Location picker or share native handles across workers.
- Initialization currently returns an always-empty service on failure. The proper compatibility fallback is the existing ripgrep service, not empty results.
- Current options include `aiMode: true`, `disableMmapCache: true`, and `disableContentIndexing: true`. Preserve these defaults initially. Enabling mmap/content indexing is not a free performance fix: it changes memory, freshness, and startup costs.
- The installed API supports `maxThreads` for filename/glob/directory/mixed searches, but Core's facade does not expose it. Grep has `timeBudgetMs`, `pageSize`, and a **file-offset** cursor. Do not assume it is a within-file continuation cursor.
- Current grep sends a single concatenated query containing path/include constraints and pattern, returns one page, and ignores `nextCursor` and `regexFallbackError`. Do not combine a responsiveness patch with an undocumented change to query grammar, regex failure behavior, or completeness.
- Grep submatch ranges and `byteOffset` are byte-based; `lineContent.length` truncation is JS UTF-16-based. Preserve that distinction. Filename results are re-sorted by score descending then path length, with stable ties.
- `packages/core/test/filesystem/search.test.ts` currently tests Ripgrep rather than the native service. New worker/native integration tests are necessary.

### Fuzzy edit

- Legacy `packages/opencode/src/tool/edit.ts:levenshtein` allocates an entire `(a.length + 1) * (b.length + 1)` nested JS matrix. It compares **UTF-16 code units**, not Unicode scalar values, bytes, or grapheme clusters.
- Only block-anchor similarity calls this function. Candidate discovery, `.trim()`, similarity accumulation, thresholds, tie order, and replacement safety checks live in JS.
- Both thresholds currently equal 0.65, but single-candidate scoring accumulates divided contributions and exits early; multiple-candidate scoring sums and divides at the end. Preserve those floating-point operation orders.
- Core's edit leaf explicitly documents deferred fuzzy behavior. Do not port legacy fuzzy fallback into Core as part of acceleration.

## 3. Package placement and shared contracts

Keep the adapter inside Core: `opencode -> Core -> native adapter`; the adapter and Rust kernels depend on neither Server nor legacy opencode. Core's wildcard export already permits `@opencode-ai/core/native/fuzzy`. No dependency on Core may be added to Client, Schema, or Protocol.

Infrastructure owner adds this private import condition to `packages/core/package.json`:

```json
"#native-acceleration": {
  "bun": "./src/native/binding.bun.ts",
  "node": "./src/native/binding.node.ts",
  "default": "./src/native/binding.node.ts"
}
```

Do not change existing `#fff` conditions in this round. Search can change the implementation behind the existing filenames without a manifest collision.

Public-to-Core adapter contracts (synchronous, internal, no Effect dependency):

```ts
// binding.bun.ts and binding.node.ts; exported namespace projection: NativeBinding
type Attempt<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "unavailable" | "unsupported" | "budget" | "invalid" | "panic" | "allocation" }

diff(oldTokens: Uint32Array, newTokens: Uint32Array, maxWork: number): Attempt<Uint32Array>
distance(a: Uint16Array, b: Uint16Array, maxWork: number): Attempt<number>

// diff.ts; namespace projection: NativeDiff; owned by diff track
summarize(file: string, before: string, after: string): {
  patch: string; additions: number; deletions: number
}

// fuzzy.ts; namespace projection: NativeFuzzy; owned by fuzzy track
distance(a: string, b: string): number
```

Type declarations are illustrative signatures, not permission to add aliases/star imports or unnecessary barrel modules. Both bindings must have identical inferred/public types. Put shared binding types in `src/native/types.ts`; it imports no runtime-native code.

The Node binding returns `unavailable` and imports no `bun:ffi`, worker, or artifact module. TS fallbacks work without Rust or native artifacts installed. Do not make Node parse/evaluate the Bun binding through a shared barrel.

## 4. ABI v1 and memory ownership

Use a small standard-library-only crate initially: package `opencode-native`, library `opencode_native`, `crate-type = ["cdylib", "rlib"]`. No Rayon/Tokio/search-engine dependency. Release builds use generic target CPU settings, not `target-cpu=native` or mandatory AVX2.

Infrastructure owner owns **all exported C functions** and wraps pure Rust modules. The contract is:

```c
uint32_t oc_abi_version_v1(void);          // exactly 1
uint32_t oc_capabilities_v1(void);         // bit 0: diff, bit 1: distance

// Opaque result; input arrays contain line-token IDs, not character offsets.
void *oc_diff_v1(const uint32_t *old_ids, uint32_t old_len,
                 const uint32_t *new_ids, uint32_t new_len,
                 uint32_t max_work);
uint32_t oc_result_status_v1(const void *result);
const uint32_t *oc_result_data_v1(const void *result);
uint32_t oc_result_len_v1(const void *result);  // number of u32 words, NOT bytes
void oc_result_free_v1(void *result);

// Strings are UTF-16 code-unit arrays. Caller owns the one-u32 output buffer.
uint32_t oc_distance_v1(const uint16_t *a, uint32_t a_len,
                       const uint16_t *b, uint32_t b_len,
                       uint32_t max_work, uint32_t *out_distance);
```

Status codes: `0 OK`, `1 UNSUPPORTED`, `2 INVALID_ARGUMENT`, `3 BUDGET_EXCEEDED`, `4 PANIC`, `5 ALLOCATION_FAILED`. `max_work == 0` is invalid, never unlimited. Functions are exported on all builds; a kernel not compiled in returns unsupported and has its capability bit cleared.

Bind `uint32_t` scalars/returns as `FFIType.u32`, pointers as `FFIType.ptr`, and free as returning `FFIType.void`. Use explicit typed-array pointers; no integer-to-pointer reconstruction, platform-sized `long`, or implicit string coercion. ABI v1 is for the repository's 64-bit little-endian targets.

Diff payload is packed `[kind, count, kind, count, ...]`, where `kind = 0 equal, 1 remove, 2 add`; each count is positive. Adjacent same-kind runs are coalesced. Empty-to-empty has zero runs. Equal/remove consume old IDs; equal/add consume new IDs. Both streams must be consumed exactly. No filenames or strings cross this ABI.

Pure module contracts, fixed so agents can begin independently:

```rust
// diff.rs
pub fn runs(old: &[u32], new: &[u32], max_work: u32) -> Result<Vec<u32>, u32>;
// fuzzy.rs
pub fn distance(a: &[u16], b: &[u16], max_work: u32) -> Result<u32, u32>;
```

The error integer is an ABI status above; these modules do not expose C functions or depend on the loader. Reserve `fuzzy` as a Cargo feature. The first foundation can compile with that feature off and export the unsupported distance stub. After fuzzy delivery, infrastructure owner enables the feature in integrated builds. Do not have two agents edit `lib.rs` or `Cargo.toml`.

Ownership rules:

- Inputs are JS-owned typed arrays, borrowed only during a synchronous FFI call. Keep strong references through return. Rust never retains their pointers or starts background work on them.
- Lengths are element counts. Validate integer/u32 bounds, alignment, length multiplication, and null-with-nonzero-length. For zero lengths explicitly use an empty Rust slice; do not call `slice::from_raw_parts` with null, even for zero length.
- Every non-null diff result is an independent Rust-owned opaque allocation. Only its accessors may inspect it. No JS struct-offset assumptions. Error results have no data and length zero. Null means allocation/unavailable failure and is handled before calling accessors.
- Bun copies the output into a JS-owned `Uint32Array` before freeing it, in `finally`, exactly once on success, decode failure, or validation failure. A `toArrayBuffer` view of native memory must not escape. Do not use a GC finalizer as the primary release mechanism.
- `oc_result_free_v1(NULL)` is a no-op. Double-free and arbitrary pointer validity cannot be made safe by this ABI: the binding must prevent them.
- Distance writes `out_distance` only on success. Rust cannot retain or free that caller-owned output.
- Rust catches unwinding panics at each computational C entry boundary; build with unwinding enabled. No Rust unwind crosses C. Use checked arithmetic and fallible reservations where useful. An allocator abort or segfault is not recoverable by JS `catch`; do not advertise crash isolation.
- No C strings, JSON serialization, callbacks into JS, shared mutable result buffers, global last-error pointers, or cross-thread native handles.
- Keep the opened library alive for its JS isolate lifetime. Do not `dlclose` while results/calls might exist. Pure kernels have no internal threads or mutable global state.

Initial hard native guardrails: 1,000,000 total diff tokens, 64 MiB maximum diff scratch allocation, and a deterministic work cap of 8,000,000 steps/cells. These are backend admission limits, not new tool limits. Count diff frontier advances and equality comparisons; count distance DP cell evaluations. Check before allocations and inside loops with checked counters. On budget exhaustion auto mode falls back to TS without changing the answer. Tune only with the benchmark report; do not return an approximate edit distance.

## 5. Loading, compatibility, and deployment artifacts

### Lazy runtime behavior

- `binding.bun.ts` may import the small `bun:ffi` API and the artifact descriptor, but must not call `dlopen` at module top level. Load once on the first eligible native kernel call. Cache success or unavailability per isolate. No first-use network download or Cargo build.
- Small calls stay TS and should never load the library. A disabled feature must not load it either.
- Use `OPENCODE_NATIVE_ACCELERATION=auto|off|force`, default `auto`, read by the adapter. `off` exercises TS; `force` is for tests/benchmarks and reports an unavailable/unsupported/error/budget backend instead of silently claiming native execution. It bypasses crossover thresholds, not hard input/work limits. Unknown values behave as auto with a diagnostic, not a startup failure.
- Search remains controlled by existing `OPENCODE_DISABLE_FFF`. Native diff/fuzzy off must not disable fff. Search does not consult the new kernel-mode flag.
- Distinguish missing library/ABI mismatch from a bad computation. Auto mode may fall back on both, with a once-per-isolate diagnostic for actual errors. Never log source text, queries, or file contents. Expose backend-used information to benchmark/test entrypoints so fallback cannot produce a false native pass.
- The synchronous fuzzy export is intentional: existing `Replacer` generators and `replace` remain synchronous. Do not introduce top-level await just to initialize a native kernel.

### Source-mode artifact selection

Infrastructure owner adds `packages/core/script/build-native.ts`. Its local default runs Cargo release for the host with `--locked`, stages the library and a descriptor under ignored `packages/core/native/dist/<rust-triple>/`, and records ABI, capabilities, triple, library SHA-256, and build provenance. `target` and `dist` are already ignored by the root `.gitignore`; no root ignore edit is necessary.

`src/native/artifact.ts` is the source-mode descriptor provider. The lazy loader resolves only the exact worktree-local artifact path relative to the module, never cwd, a sibling worktree, PATH, or a user's oc installation. If absent, auto mode uses TS. Host Linux libc detection must distinguish glibc/musl or conservatively disable; do not shell out to `ldd` on every kernel call.

### Compiled executable packaging

Infrastructure owner adds a reusable build plugin/helper `packages/opencode/script/native-artifacts.ts` and calls it from `script/build.ts`:

1. Map each Bun target explicitly to a Rust triple and extension (`libopencode_native.so`, `libopencode_native.dylib`, `opencode_native.dll`). x64 baseline and regular Bun executables can share the same generic-CPU native library.
2. For an available, validated target artifact, replace only Core's resolved `src/native/artifact.ts` module with generated source containing a **literal** file import: `import library from "/absolute/staged/library" with { type: "file" }`, plus the target/ABI/hash descriptor. This can use a narrowly scoped Bun build plugin; do not edit tracked source per target or rely on opaque runtime `require.resolve` to embed a library.
3. With no artifact, generate an explicit disabled descriptor. `--single` on the supported host builds the native artifact by default. Multi-target builds may use supplied prebuilt artifacts and print an explicit acceleration support table. Add `--require-native` to fail for a missing required target; add `--skip-native` for intentional TS-only compatibility builds. Never embed a host `.so` in another platform's executable.
4. In compiled mode use only the embedded descriptor. Do not probe developer source paths if it says disabled. Pass the embedded file-import path to `dlopen`, following fff's existing pattern. Bun owns the executable-backed artifact/extraction behavior; do not add a custom persistent extraction cache in v1.
5. Keep existing fff installs, `FFF_LIBC`, OpenTUI defines, and TUI/tree-sitter entries. Preserve the target distinction between fff's `gnu` and opencode's `glibc` spelling.
6. Add the search worker entry after the search files exist. Define `OPENCODE_FFF_WORKER_PATH` to its stable embedded path. Prefer a virtual `opencode-fff-worker.ts` entry in `Bun.build.files` containing `import "../core/src/filesystem/fff.worker.ts"`; resolve that source import relative to the opencode build root. Add the virtual entry to `entrypoints`. Verify the actual emitted Bun path instead of assuming source URL resolution works in a compiled executable. Before integration the entry is omitted if the search source is absent; after integration test that it is included.

Target map:

| Bun target family | Rust target |
| --- | --- |
| linux-x64 / baseline, glibc | `x86_64-unknown-linux-gnu` |
| linux-arm64, glibc | `aarch64-unknown-linux-gnu` |
| linux-x64-musl / baseline | `x86_64-unknown-linux-musl` |
| linux-arm64-musl | `aarch64-unknown-linux-musl` |
| darwin-x64 / baseline | `x86_64-apple-darwin` |
| darwin-arm64 | `aarch64-apple-darwin` |
| windows-x64 / baseline | `x86_64-pc-windows-msvc` |
| windows-arm64 | `aarch64-pc-windows-msvc` |

Only claim runtime support for tested targets. Linux x64 glibc is the first acceptance target. Musl `cdylib` linkage, Windows toolchains, macOS signing/loading, minimum glibc, and baseline CPU compatibility require target-native build/test jobs before enabling their artifacts. A target triple string alone is not cross-toolchain support. Untested targets retain TS kernels and the existing search runtime fallback. Do not bundle libc or depend on developer-only shared libraries.

Check source and compiled loading on installed Bun 1.4.2 and, when available, the repository-pinned Bun 1.3.14. If the latter cannot be tested, report it as unverified; do not claim a minimum-version guarantee or change the root package manager pin from a track worktree.

A compiled smoke executable must be moved to an empty directory and run with a different cwd, no adjacent native library/node_modules, and isolated HOME/XDG directories. It must force and execute both kernels, exercise the embedded search worker when integrated, and identify the selected backend. `oc --version` alone proves none of that. Reuse the same packaging helper for the smoke executable and production build.

## 6. Diff track implementation

### First win: one JS diff

Implement `NativeDiff.summarize` using `structuredPatch(file, file, before, after)` once. Sum hunk lines whose first character is `+` or `-`, excluding context and `\ No newline at end of file` markers; file headers are not in hunk lines. Then call `formatPatch` exactly once. Test this result against the original two-call implementation, including counts, before wiring it into Core.

Call it at the existing diff calculation boundaries. In edit, preserve stale-content writes and the result resource used in headers; verify the relationship between `target.resource` and returned `result.resource` before moving patch computation. In apply-patch, keep all patch results prepared before sequential writes. Do not change replacement rules, JS replacement-string interpretation, BOM policy, permissions, file status, or tool output shape.

### Native kernel

- Tokenize lines exactly as jsdiff 8.0.2's default `diffLines`: tokens include their terminating LF/CRLF, no extra empty token after a final newline, and a final unterminated line is distinct. A bare CR stays content. Do not enable ignoreWhitespace/stripTrailingCr/ignoreNewlineAtEof.
- Intern token strings across old and new arrays to exact u32 IDs in TS. Map equality must be exact JS string equality, with no hash-collision shortcuts. Preserve JS strings, including lone surrogates, in TS; Rust only sees IDs.
- Port the small relevant default Myers path logic, including tie-breaking, edge pruning, and run ordering, into `diff.rs`. Retain upstream attribution/license if code is adapted. Do not substitute patience/histogram diff or normalize equal-cost edit scripts.
- Reconstruct changes from returned runs and original TS tokens. Build a structured patch using a narrowly scoped local conversion equivalent to jsdiff's `diffLinesResultToPatch` (default context 4), then use the public `formatPatch`. The library does not expose that conversion as a public function; do not deep-import/monkey-patch its internals.
- Counts come from the same runs. Never run `diffLines` again on the native success path. The optimized-TS path remains the reference fallback.
- Common-prefix/suffix or hashing optimizations are accepted only if full patch-byte parity survives; removing common suffixes can alter tie choices.

No diff worker pool in this iteration. These are synchronous CPU kernels behind existing synchronous calculations, bounded natively as above. No Promise wrapper makes them asynchronous. There is no mid-call JS cancellation; Effect interruption is observed outside the synchronous call. If the benchmark shows unacceptable event-loop stalls, leave native auto routing off for that class and report that asynchronous diff is follow-up work, not a reason to introduce a second scheduler during this change.

## 7. Search track implementation

### Worker boundary

Keep `FileSystemSearch.Interface` unchanged. Make the existing Bun `#fff` facade an asynchronous worker client; the Node facade stays unavailable and has matching portable types. Move shared facade DTOs into `filesystem/fff-types.ts` with no runtime import of `@ff-labs/fff-bun`.

- On first search use in a Location, create one dedicated Bun Worker. Its module alone dynamically imports `@ff-labs/fff-bun`, creates one `FileFinder`, and owns it until disposal. Do not run `FileFinder.isAvailable()` on the main/server isolate.
- In source mode resolve `new URL("./fff.worker.ts", import.meta.url)` from the colocated client/facade. In compiled mode use `OPENCODE_FFF_WORKER_PATH` when defined; never depend on the build machine's source URL. Keep the declaration in the search-owned facade/client, not a shared global-types file.
- The parent sends structured-clone DTOs, never native pointers, Effect services, or callback functions. Worker request envelope: `{ id: number, op, args }`; response: `{ id, ok: true, value } | { id, ok: false, error: { kind, message } }`. IDs are monotonically increasing safe integers per worker, not globally reused IDs.
- Ops needed now: init, fileSearch, glob, directorySearch, mixedSearch, grep, dispose. Keep other existing facade methods only if callers require them; search repository references before removing an exported helper. No general RPC framework is necessary.
- During init retain existing options and report a readiness/failure response. Preserve the existing ability to return partial scan results rather than blocking every first query on a full scan. Tests/benchmarks explicitly wait for scan readiness to compare stable outputs; cold-start measurements include it separately.
- Serialize all native operations on that picker. Only one request may execute inside FFI at a time. Bound admitted RPC requests to 32 per Location with interruptible backpressure; do not drop or resolve excess requests as empty arrays. The pending scheduler stays on the parent side so a blocked worker cannot prevent queue cancellation.
- Keep native DTO unpacking/result freeing and preferably byte-range-to-text conversion inside the worker to minimize large parent-side work. Schema validation/materialization can remain in Core. Measure structured-clone payload size and main-thread formatting time.

### Cancellation and disposal

Use the abort signal supplied by `Effect.tryPromise` or `Effect.callback`; these signatures exist in the installed Effect v4 beta. Bind services before using them. Use the Location scope and `Effect.addFinalizer` for the worker lifetime. Do not introduce ambient instance context or broad `catchCause` recovery.

Cancellation is **logical**, not native preemption:

1. Aborting a queued request removes it before dispatch.
2. Aborting an active request immediately stops delivering a result to that caller. The native call continues; its eventual result is freed normally in the worker and discarded by request ID. Its execution slot remains occupied until completion.
3. A cancel message cannot interrupt synchronous FFI on the worker event loop. Do not promise otherwise or free a picker underneath an active call.
4. A caller's explicit interruption must survive; do not turn it into fallback work or `[]`. Do not apply “latest query wins” globally: independent sessions may search the same Location concurrently.
5. Disposal stops admission, settles pending callers, waits for the active operation to return, destroys the picker in its owning worker, acknowledges disposal, and then closes/terminates the idle worker. Do not forcibly terminate a live native operation as routine cancellation: Rust watcher/DB resources may not be destructed. Test clean process exit and repeated Location open/close.

Retain the existing 1,500 ms grep budget in the first worker implementation. It is a soft engine budget, not a hard shutdown guarantee. Do not reduce it to 25–50 ms and blindly concatenate pages: the cursor is file-based, and page limits may stop within a matching file. A future sliced mode must prove no skipped/duplicate matches, preserved ordering, and equivalent defaults before use. Filename/glob calls have no verified preemption mechanism; report that limitation.

### Fallback and targeted optimization

- Lazily build the existing ripgrep implementation when fff is disabled, unsupported, cannot load/create, or the worker cannot start. Refactor the existing ripgrep service construction into a reused helper if necessary. Never return permanent empty results because native initialization failed.
- Catch only expected availability/worker transport failures for fallback. Do not reinterpret invalid regex/query behavior, programming defects, or interruption as successful fallback. A native segfault still terminates the process; a Worker is not process isolation.
- Preserve the current query construction, page-size/default behavior, sort ties, 2,000-code-unit truncation, Unicode byte ranges, and Location-relative paths. Document existing behavior defects separately.
- First optimize the ripgrep file-scan callback's repeated `Array.from(directories)` rebuild: materialize when consumed or once per batch, maintaining an explicit readiness model. It currently rebuilds the whole directory list per entry.
- Expose `maxThreads` in internal options only if benchmarking shows a benefit for concurrent Locations. Avoid oversubscribing a worker per Location plus unlimited internal native threads. Do not blindly change the default for grep, whose API has no equivalent parameter.
- Do not turn on indexing/mmap, add caches with unclear invalidation, or replace regex/ignore handling in this delivery.

## 8. Fuzzy track implementation

First make `NativeFuzzy.distance` an exact rolling-row Levenshtein implementation over UTF-16 code units, O(min(m,n)) auxiliary memory. Empty strings and equal strings fast-path. Prefix/suffix trimming is allowed for distance if exact tests pass. Avoid unproven per-line threshold cutoffs: final block similarity averages several lines and threshold logic is not a simple independent edit-distance cutoff.

Implement the same kernel in `native/src/fuzzy.rs`, accepting borrowed u16 slices. No `String::from_utf16_lossy`, UTF-8 conversion, Rust `.chars()`, Unicode normalization, or Rust whitespace rules. The TS wrapper constructs `Uint16Array` with `charCodeAt`, uses the shared binding only above a measured crossover, and otherwise uses rolling rows. A native budget miss falls back to the optimized TS kernel in auto mode.

In legacy `tool/edit.ts`, replace only the private distance implementation/calls and clearly parity-safe local allocation work. Leave candidate discovery and scoring in JS initially. Preserve:

- Replacer order: simple, line-trimmed, block-anchor, whitespace-normalized, indentation-flexible, escape-normalized, trimmed-boundary, context-aware, multi-occurrence.
- First matching closing anchor behavior, block-size delta, trailing-empty-line handling, blank middle-line contributions, thresholds and floating-point accumulation order.
- First winner on equal similarity (`>` rather than `>=`), ambiguity detection, disproportionate-match checks, replaceAll semantics, exact error strings, and all BOM/newline/formatter/permission behavior.
- Synchronous generator and exported `replace` contracts. No changes to Core's edit or patch matching.

Per-line FFI is a conscious low-complexity first step. If conversion/call overhead loses to rolling-row TS, keep auto mode on TS for those sizes. Do not invent a batch ABI or native candidate-ranking protocol without a coordinated revision from the infrastructure owner.

## 9. Exclusive ownership and collision avoidance

All paths below are relative to the worktree root. Only the named owner edits them. Additional files require parent coordination before editing, especially manifests, lockfiles, build scripts, or legacy edit.

| Owner | Exclusive files / areas |
| --- | --- |
| **Diff / infrastructure** | `packages/core/native/{Cargo.toml,Cargo.lock,README.md,src/lib.rs,src/diff.rs}`, native shared ABI tests and attribution under that crate; `packages/core/script/build-native.ts`; `packages/core/src/native/{types.ts,binding.bun.ts,binding.node.ts,artifact.ts,diff.ts}`; `packages/core/package.json`; `packages/opencode/script/{build.ts,native-artifacts.ts}`; `packages/core/src/tool/{edit.ts,apply-patch.ts}`; `packages/core/test/tool-{edit,apply-patch}.test.ts`; `packages/core/test/native/{abi,diff,artifact}.test.ts` and compiled smoke entry; `packages/core/bench/native-diff.ts`; `specs/rust-native-diff-results.md` |
| **Search** | `packages/core/src/filesystem/{search.ts,fff.bun.ts,fff.node.ts,fff-types.ts,fff.worker.ts,fff-client.ts}` (client file only if useful); `packages/core/test/filesystem/{search,fff-worker}.test.ts`; `packages/core/bench/native-search.ts`; `specs/rust-native-search-results.md` |
| **Fuzzy** | `packages/core/native/src/fuzzy.rs` (unit tests in that module); `packages/core/src/native/fuzzy.ts`; `packages/opencode/src/tool/edit.ts`; `packages/opencode/test/tool/{edit,edit-fuzzy}.test.ts`; `packages/core/test/native/fuzzy.test.ts`; `packages/core/bench/native-fuzzy.ts`; `specs/rust-native-fuzzy-results.md` |
| **Parent coordinator** | Main-checkout integration, this frozen shared design, handling unrelated dirty work, any explicitly approved changes outside these sets, final combined verification/build/deploy |

No track needs a new JS dependency. Infrastructure owner alone may make a justified manifest/lockfile change; tell the parent first if a root `bun.lock` change is required. Prefer std-only Rust kernels and public `diff` APIs already installed. Search requests build changes from infrastructure owner instead of editing `build.ts`. Fuzzy requests ABI/feature changes instead of editing shared bindings or crate manifests.

### Integration sequence

1. All three agents create separate worktrees from the exact base and copy this document. Start reference tests and TS/worker work independently.
2. Infrastructure owner publishes a minimal foundation patch early: Cargo manifest/lib wrappers (distance capability off), bindings/types, artifact descriptor/build helper. Include the exact ABI smoke command. Do not wait for a finished diff algorithm.
3. Parent distributes this patch to fuzzy's worktree via `apply_patch` as **borrowed, read-only infrastructure**, recording its path list/hash. Fuzzy can test its std-only module beforehand with `rustc --test`; it must not author a second Cargo manifest. Borrowed foundation changes are excluded from fuzzy's delivered patch. Search needs no foundation to test source-mode workers.
4. Search reports its exact worker filename/define contract to infrastructure owner. Parent can copy the shared build helper into search's worktree for compiled smoke verification; it remains borrowed/read-only and excluded from delivery.
5. Integrate infrastructure/diff first, then fuzzy module/wrapper/legacy changes; infrastructure owner wires/enables the fuzzy feature. Integrate search and its worker entry. Do not deploy any intermediate worktree build.
6. Parent reruns combined parity, cancellation/resource cleanup, fallback, compiled artifact tests and measured crossover gates, then builds and deploys the integrated result according to root AGENTS.md.

Use patches/file manifests rather than merging three competing foundation implementations. No agent may fix a shared-contract mismatch by silently changing both sides in its private tree.

## 10. Verification and benchmarking

### Correctness gates (mandatory)

**Diff:** compare complete `{patch, additions, deletions}` against jsdiff 8.0.2's current two-call baseline for unchanged, empty/add/delete, one-line replace, insert/delete at boundaries, repeated/alternating identical lines, overlapping context windows, distant hunks, CRLF/LF/mixed endings, bare CR, final-newline-only changes, BOM, NUL, astral characters, combining marks, and lone surrogates. Test Unicode and unusual filenames in headers. Seed randomized small line arrays rich in repeats to expose tie-breaking. Verify patch applicability when the baseline is applicable; identical bytes are the primary oracle. Test mutation/permission/stale-write behavior using existing Core tool tests.

**Fuzzy:** compare exact distances with the original matrix on a bounded exhaustive/generated corpus and with saved baseline fixtures; compare actual exported replacer candidates and `replace` results/errors, not just a duplicated scorer. Include empty/equal strings, transpositions (distance 2 where appropriate), long similar/dissimilar lines, surrogate pairs, isolated surrogates, combining marks, ECMAScript whitespace including NBSP/BOM, threshold-adjacent blocks, blank interiors, equal-score candidates, first-closing-anchor quirks, repeated matches, trailing newline, CRLF, replaceAll, and disproportionate spans. Existing edit integration tests must pass. Core edit tests must continue rejecting non-exact matches.

**Search:** compare direct existing fff versus worker fff on the same quiescent fixture/index with identical options, stable readiness, and isolated frecency/history state. Include filenames/directories/mixed order, spaces and Unicode paths, hidden/ignored files, include/path constraints, invalid regex behavior, limits/defaults, many matches in one file, Unicode byte ranges and multibyte text before matches, long lines, file mutation/watch freshness, concurrent Locations, queued/active cancellation, disposal during a query, and no post-disposal result delivery. Separately test ripgrep fallback on disabled/missing/startup-failed fff. Do not assert fff and ripgrep have identical fuzzy ranking.

**ABI/artifacts:** invalid arguments, zero-length input, capability/version mismatch, missing/wrong-target library, forced-vs-auto backend selection, budget exhaustion, copied-result lifetime, many repeated calls with stable memory, panic containment using a test-only native path, and Node import without Bun-native evaluation. Run native tests and real FFI tests, not mocks of the kernel. Never send arbitrary invalid non-null pointers to test “validation.”

### Benchmark method

Reports must give hardware, OS/libc, Bun/Rust versions, exact Git base and patch identity, build profile, flags, dataset seed/size, backend actually used, warmup policy, iterations, median/p95, peak RSS, and event-loop delay. No speedup claims are established by this design.

- Diff: original `diffLines + createTwoFilesPatch`; one-pass `structuredPatch + counts + formatPatch`; native pipeline **including** tokenization, interning, FFI copying, and patch assembly. Measure 1 KiB, 32 KiB, 256 KiB, 1 MiB, and larger representative source files; small edits, append-only, repeated lines, and whole rewrites. Separate kernel-only numbers from end-to-end numbers.
- Fuzzy: original full matrix (only safe bounded sizes), rolling-row TS, and native including UTF-16 conversion/call cost. Also benchmark full block-anchor replacement with one/many candidates. Do not OOM the machine just to establish a baseline; record baseline timeout/memory ceiling and stopped cases.
- Search: direct synchronous fff baseline, off-thread fff with unchanged options, then individually measured TS allocation/thread-budget changes. Measure index startup, first query, warm repeated query, rapidly superseded **explicitly aborted** queries, 10k/100k-file synthetic fixtures plus this repository, and multiple simultaneous Locations. Record request latency separately from caller/server event-loop p95/max lag and cancellation-settlement latency. Calling something “native vs TS search” would be misleading: fff is already native. Ripgrep is a separate semantic fallback, not the same algorithm baseline.
- Run comparison variants on identical fixture data from isolated benchmark entrypoints. Keep measured runs free of model/network requests. Measure cold `dlopen` and worker startup in fresh processes, not only cached steady state. Use subprocess-level RSS measurements where JS heap statistics miss Rust memory.

### Go/no-go policy

1. Zero known parity failures for an enabled backend. Never weaken tests to accept a different but “valid” diff or fuzzy match.
2. Ship one-pass TS diff and rolling-row TS fuzzy when parity passes and representative p95 does not regress more than 10%; record the memory reduction for fuzzy.
3. Enable a native kernel in auto mode only for measured size/work ranges with at least **1.5x median end-to-end speedup over optimized TS**, no more than 10% p95 regression, and acceptable memory. Small-call routing must not regress p95 by over 5% or 0.1 ms, whichever is larger. Set separate crossovers for diff token count and fuzzy DP area, with conversion cost included. Do not hardcode a crossover merely because Rust is expected to be faster.
4. Accept worker search primarily for responsiveness: on a corpus where synchronous fff visibly blocks, aim for caller event-loop p95 below 20 ms, no routine stall above 100 ms, and aborted-caller settlement below 50 ms p95. Warm query latency should stay within 20% or 2 ms of baseline, whichever is larger. If payload conversion exceeds these gates, optimize the measured boundary; do not discard correctness or pretend the native call was interrupted.
5. No index-memory blowup: report per-Location idle/active RSS; unchanged engine options should avoid duplicating indexes. Repeated open/query/dispose cycles must plateau rather than leak workers/native handles. Absolute timing gates are benchmark acceptance evidence, not sleep-based CI assertions.
6. Native auto-enable requires relocated compiled smoke success on the target. If packaging, parity, or speed fails, keep that kernel TS/default-disabled and deliver the measured findings. Do not block useful independent wins on finishing every cross-platform native build.

### Commands and expected verification locations

Commands below assume the named working directory; do not run tests from repository root. New script names are contracts for infrastructure owner to supply, not files that exist at the base.

- `packages/core/native`: `cargo test --locked`; after integration `cargo test --locked --features fuzzy`; `cargo fmt --check`; `cargo clippy --locked --all-targets --features fuzzy -- -D warnings` once fuzzy exists.
- `packages/core`: `bun run script/build-native.ts`; `bun typecheck`; focused `bun test test/native` and affected `test/tool-edit.test.ts`, `test/tool-apply-patch.test.ts`, `test/filesystem/search.test.ts`, `test/filesystem/fff-worker.test.ts` as appropriate. Run real native tests with forced mode and fallback tests in separate off-mode processes.
- `packages/opencode`: `bun typecheck`; `bun test test/tool/edit.test.ts test/tool/edit-fuzzy.test.ts` for fuzzy; build integration uses `bun run script/build.ts --single --skip-install --skip-embed-web-ui`.
- Use package-local scripts for `bench/native-diff.ts`, `bench/native-search.ts`, and `bench/native-fuzzy.ts`, writing results only in the worktree's ignored output directory and the owner's results document.
- Infrastructure owner provides a compiled-smoke test using the shared packaging helper. Search owner supplies a source-mode smoke test and runs the compiled one when borrowed infrastructure is available.
- The full build imports `script/generate.ts`, which fetches models.dev unless `MODELS_DEV_API_JSON` points to a valid local snapshot. Record offline/network failures accurately; do not rewrite the build or use arbitrary placeholder model data to claim success.
- Record pre-existing base failures separately, with the exact command and failure. Do not “fix” unrelated tests/types or dirty user changes to get a green report.

## 11. Worktree and dependency instructions

The main checkout contains extensive unrelated dirty user changes. Its root `AGENTS.md` itself is modified. Do not stash, reset, clean, restore, checkout, commit, or deploy from it. Read the current main-checkout instructions as well as worktree instructions; missing uncommitted instructions in a new worktree do not grant permission to ignore this task's constraints.

For each implementation agent:

1. Read `/home/shawn/code/opencode/AGENTS.md`, applicable nested instructions, and this document. Verify `git rev-parse HEAD` in the source still identifies the agreed base. Ask the parent if HEAD changed; do not silently change the baseline.
2. Verify `/tmp/opencode` exists with `ls /tmp/opencode`. From the main repository create exactly one new worktree using the full base SHA, for example:

   ```text
   git worktree add -b native-diff /tmp/opencode/native-diff f47dff9ad36a778b1dbd0a99fff6a5a0b2fdf62a
   git worktree add -b native-search /tmp/opencode/native-search f47dff9ad36a778b1dbd0a99fff6a5a0b2fdf62a
   git worktree add -b native-fuzzy /tmp/opencode/native-fuzzy f47dff9ad36a778b1dbd0a99fff6a5a0b2fdf62a
   ```

   Each agent runs only its own command. If a branch/path already exists, report it and choose a parent-approved unused short name; never remove an unfamiliar worktree. These operations do not check out a different branch in the main working directory.
3. Read the uncommitted design from the main checkout and create the exact same `specs/rust-native-acceleration.md` in the new worktree using **apply_patch**. Do not assume Git copied it. Treat this copied document as read-only shared input and exclude it from implementation patches.
4. Run every subsequent build/edit/test with that worktree as cwd or an explicit package cwd. Verify `git status --short` before edits. Never install a worktree binary into `~/.local/bin/oc` or `~/.local/share/oc/bin/opencode`.
5. Dependencies may be missing: Git worktrees do not include ignored node_modules or Rust artifacts. At the worktree root run `bun install --frozen-lockfile`. Installation is allowed there even though package tests are not. Inspect status afterwards. Do not regenerate `bun.lock` merely to make install pass. Report genuine resolution failures to the parent/infrastructure owner.
6. Prefer a real worktree-local install over linking the main checkout's node_modules. Workspace package links must resolve to this worktree, not `/home/shawn/code/opencode/packages/...`. Verify using `import.meta.resolve("@opencode-ai/core/filesystem/search")` from the appropriate package and realpath/readlink inspection when needed. The root postinstall runs Core's node-pty repair, another reason not to share mutable node_modules blindly.
7. Cargo can share its download cache but must use a worktree-local `target` directory. Do not point `CARGO_TARGET_DIR`, native artifacts, or Bun build output at the main checkout. Borrowed foundation files are copied via apply_patch, not symlinked for edits.
8. Produce owned changes and a results report; no commits, pushes, or deployments unless separately authorized. Report a precise modified/untracked file manifest and borrowed-file exclusions so the parent can integrate untracked files as well as `git diff` output. Never use `git add .` as an export shortcut.

Implementation agents may build and run their worktree's `dist/.../opencode` directly with isolated HOME/XDG directories. **Deployment is explicitly delegated to the parent**: after integration, the parent runs the mandated build, atomically replaces `~/.local/share/oc/bin/opencode`, verifies `oc --version` and binary identity, and notes that running sessions require restart. The design-only phase makes no code changes and performs no deployment.

## 12. Exact implementation prompts

The coordinator should pass the common preamble plus the relevant track prompt verbatim. The design agent's job ends at this document; the coordinator launches implementation agents afterward.

### Common preamble

> Implement only your assigned track from `/home/shawn/code/opencode/specs/rust-native-acceleration.md`. First read the current main-checkout and applicable nested AGENTS.md instructions. Create your own worktree from `f47dff9ad36a778b1dbd0a99fff6a5a0b2fdf62a` under `/tmp/opencode` using the specified short branch name; copy this uncommitted design into it using apply_patch. Main checkout contains unrelated dirty user work: do not edit, stash, reset, clean, checkout, commit, or deploy there. Follow the ownership table exactly. Do not spawn further agents. Use worktree-local dependency resolution/artifacts. No commits or deployment from your worktree. Run meaningful parity/fallback/performance checks and package-local typechecks; report blockers and pre-existing failures honestly. Return worktree/branch, exact owned changed/untracked files, borrowed-file exclusions, tests and benchmark commands/results, backend go/no-go decision, and integration requests. Do not modify the shared design or invent a competing ABI/package/loader.

### Track 1: diff and infrastructure — branch `native-diff`

> You own diff and all shared native/build infrastructure in sections 3–6 and 9. Publish a small working foundation patch early so fuzzy can use the fixed binding API: one std-only Core Rust cdylib, version/capability checks, ownership-safe C ABI, conditional Bun/Node bindings, and artifact descriptor/build support. Keep the fuzzy feature off until its module arrives, but provide the distance symbol/unsupported capability contract. Implement the one-pass JS patch+counts optimization in Core edit/apply-patch first, then a jsdiff-8.0.2-compatible native token-ID diff kernel and patch conversion with exact byte/count parity. Own packages/core/package.json and opencode's build/helper; coordinate the search worker define/entry without editing search files. Do not edit legacy packages/opencode/src/tool/edit.ts. Do not add napi-rs or a new workspace package. Benchmark baseline vs one-pass TS vs full native pipeline and enable native only where gates pass. Provide relocated compiled smoke coverage and exact artifact/platform support findings. Keep every output/build local to your worktree; parent integrates and deploys.

### Track 2: native search responsiveness — branch `native-search`

> You own only search files/tests/benchmark/results in section 9. Existing fff is already Rust; retain @ff-labs/fff-bun 0.9.4 and implement lazy Location-owned worker execution behind #fff, logical cancellation, bounded queueing, clean native lifetime/disposal, and real ripgrep fallback on initialization/worker-start failure. Preserve query/ranking/limit/byte-range semantics and current indexing options. Do not claim synchronous FFI is preemptible or blindly slice grep using its file-offset cursor. Benchmark caller event-loop responsiveness as well as query latency; measure targeted ripgrep allocation/maxThreads changes independently. Publish the exact fff.worker.ts / OPENCODE_FFF_WORKER_PATH requirement to the infrastructure owner; do not edit manifests, lockfiles, Rust crate, shared bindings, build.ts, TUI, Schema, or APIs. Test source workers independently; use borrowed read-only build infrastructure for compiled verification when supplied. No worktree deployment.

### Track 3: fuzzy edit matching — branch `native-fuzzy`

> You own only fuzzy files/tests/benchmark/results in section 9, including legacy packages/opencode/src/tool/edit.ts. Replace its full Levenshtein matrix with exact UTF-16 rolling-row TS and implement native/src/fuzzy.rs with the fixed pure Rust distance signature. Use the shared binding through Core's native/fuzzy.ts wrapper; obtain foundation files as borrowed read-only input, never make a second crate/ABI/loader. Keep the existing synchronous replacer API, JS trim/candidate discovery/scoring order, 0.65 thresholds, first-tie behavior, errors and replacement safeguards. Core edit remains exact; do not edit Core tool/edit.ts or patch matching. Start bounded oracle/parity tests and the standalone Rust module before foundation arrives; request the infrastructure owner to enable the feature after integration. Benchmark full-matrix baseline vs rolling-row TS vs native including conversion/call overhead and full block matching. It is valid to keep native auto-disabled where rolling-row TS wins. No worktree deployment.

## 13. Principal risks and deliberate limits

- **Semantic drift is the largest diff/fuzzy risk:** Unicode unit choice, jsdiff tie-breaking, EOF markers, and floating-point threshold order can change actual edits or displayed patches.
- **Worker packaging must be proven:** the existing TUI worker pattern and fff file imports are strong precedents, not proof that a newly introduced nested Core worker is embedded correctly.
- **Search cancellation does not stop Rust:** callers become responsive immediately, but the worker remains occupied until native return. A thread is not crash isolation; forced termination can leak native resources.
- **Native speed is not guaranteed:** TS interning/UTF-16 conversion, native-result copying, and patch formatting may dominate. Compare against optimized TS, not only the avoidably expensive baseline.
- **Cross-target release builds need real toolchains:** never confuse Bun's target support with native library availability or ABI compatibility. TS fallback keeps unsupported targets usable.
- **Main-checkout state is not the implementation baseline:** agents start from HEAD and copy only this design/shared foundation, not unrelated uncommitted application changes. Parent owns conflicts with the user's ongoing work and the final build/deploy.

# Native acceleration: independent acceptance addendum

Companion to `rust-native-acceleration.md`. These requirements refine acceptance after independent design review; they are not claims that unfinished implementations contain these defects. Parent coordinates application at each implementation handoff.

## Worker lifecycle

- Register scoped ownership of the worker client before awaiting initialization. Initialization must remain interruptible, and a late-created picker must be destroyed after disposal.
- Concurrent first callers share initialization; interrupting one caller must not cancel other callers' initialization.
- Disposal is idempotent in starting, ready, and failed states. Its control path bypasses stopped/full ordinary RPC admission.
- Active cancellation settles the caller promptly but retains active-operation bookkeeping until completion. It does not preempt synchronous Rust.
- Startup failure, worker error/exit, and synchronous postMessage failure settle all affected requests, admission waiters, and disposal waiters. A dead worker does not require an acknowledgement.
- Successful disposal acknowledgement follows picker destruction. Bun Worker.terminate() returns void; awaiting it does not establish exit ordering. Unreferenced workers allowing process exit do not establish cleanup.
- Exercise initializing, admission-blocked, queued, and active interruption with readiness signals. Effect callers must retain interrupted Exits rather than fallback/empty success or ordinary failure.
- Exercise disposal with an active request, full queue, and admission waiters. Verify exactly-once cleanup and an explicit cleanup marker in an isolated subprocess with an external watchdog.

## Native execution evidence

- Force mode must reach the computational ABI for supported empty, equal, and small inputs, or explicitly label an intentionally TS-only shortcut and exclude it from native coverage.
- Missing artifacts, unsupported capabilities, and budget failures must be observable in force mode, including on fast-path inputs.
- Backend evidence must describe the current invocation, not the configured mode, successful library loading, or a stale last-backend value.
- Native-designated tests must not silently skip missing artifacts and count the suite as verified.
- Test forced, off, and automatic budget-fallback cases in separate processes. Include attempted-native-plus-TS fallback cost in benchmarks.

## ABI ownership and validation

- Document actual caller preconditions: initialized readable input allocations, no concurrent mutation/detachment/resizing, writable aligned output storage, no output aliasing live shared input references, and live result handles from the same loaded library.
- Null/alignment/length checks do not prove arbitrary pointer validity. Bindings should use owned buffers or reject/copy shared backing stores.
- Shared-buffer checks must work across JavaScript realms. `instanceof SharedArrayBuffer` is insufficient; cover foreign-realm buffers with a realm-independent check before entering native code.
- Before constructing a native-memory result view, check byte arithmetic, even word count, and the maximum of twice the combined input token count. Zero-length data must not dereference a null pointer.
- Validate kinds, positive counts, cumulative input consumption, and equality of token IDs covered by equal runs.
- Test two live results, independent frees, copied JS output after freeing and further allocations, unchanged distance output on errors, and repeated allocation/free behavior.
- Panic containment should be exercised through a test-only exported computational boundary. Do not pass arbitrary invalid non-null pointers in tests.

## Hermetic compiled verification

- Source-mode native builds must stage and validate a new same-filesystem library, then atomically rename it into place and atomically publish its descriptor. Never truncate/overwrite an inode that a running process may have mapped.
- Relocating an executable is insufficient while absolute source paths remain accessible. Run the compiled smoke with source checkouts, worktrees, developer libraries, and node_modules inaccessible.
- On Linux, bubblewrap can expose only /usr, required system library symlinks, /proc, /dev, an empty temporary filesystem, isolated HOME/XDG state, and a directory containing only the executable and intended fixtures. Disable networking and enforce an external timeout.
- Require affirmative native diff and distance invocation evidence, worker-owned FFF execution, embedded artifact/worker paths, and completed disposal. Search fallback fails this positive smoke.
- Verify a compiled-disabled negative case: force fails and auto uses TS despite available developer artifacts outside the sandbox.
- Exercise the production executable's real tool/search wiring as well as a helper smoke. A helper-only success does not prove the production entrypoint and defines are wired correctly.
- Only actually tested platform/runtime combinations may be called verified. Repository-pinned Bun 1.3.14 remains unverified until exercised.

## Semantic and performance gates

- Diff parity compares exact bytes and counts with the original jsdiff implementation, including repeated-line tie paths, EOF markers, bare CR, empty hunks, unusual headers, and context gaps of eight versus nine lines.
- Fuzzy parity checks real exported replacer candidates/results/errors, UTF-16 including isolated surrogates, first closing anchors, blank-line denominators, early exits, floating-point accumulation, and first-winner ties.
- Search parity compares direct FFF and worker FFF after verified scan completion; an ok result with value false is not scan readiness. Preserve order, first-page behavior, regex behavior, byte ranges, and UTF-16 truncation.
- Known parity failure blocks the affected backend. Auto-enablement requires the original design's full-pipeline speed gates over optimized TS and successful hermetic compiled verification.
- Existing baseline tests supplement, but do not replace, new ABI and worker lifecycle tests.

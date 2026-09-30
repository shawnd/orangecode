# Scoped tool diagnostic metadata (table item 3)

## Baseline and finding

- Baseline tree: `e6f0f15a59125fb1775dd081da144ec16c4622aa` (the supplied worktree index, not HEAD).
- Worktree: `/tmp/opencode/perf-batch/diagnostic-metadata`.
- Runtime: Bun 1.4.2 (744846f84), Linux x64.
- Baseline measurement completed before any runtime edits. Changes remain uncommitted; integration, combined typechecking, build and deployment belong to the parent.

Confirmed the finding. Edit, Write and Apply Patch copied workspace-wide diagnostics into completed tool metadata. `processor.ts` passes that metadata through, `Session.updatePart` clones the part, and the core projection persists it. There is an additional source-level cost: `client.diagnostics` constructs a new map and merges/deduplicates push/pull diagnostics for **every cached file** on every retrieval.

Consumers inspected: TUI `routes/session/index.tsx` reads diagnostics for the input file or each patch target (including move destinations); session-ui `components/message-part.tsx` also selects the input file. Write intentionally renders at most five other files with errors, using `Diagnostic.report`'s existing 20-error display limit and overflow count. No inspected consumer requires global diagnostics in persisted tool metadata.

## Implementation

- Add client `diagnosticsFor(file)`, lazy `diagnosticFiles()` and raw-cache `hasDiagnosticErrors(file)` accessors. Only selected files incur merging/deduplication. Notification handlers, cache updates, document text and wait logic are unchanged.
- Extend the internal LSP service's diagnostics query with optional `{ files, otherFiles }`. Normalize relative/absolute paths against the instance directory and deduplicate requested paths. The file-only path looks up selected files directly across clients.
- The bounded-context path preserves the old first-seen file order across clients. It considers errors on **all** clients before rejecting a candidate: warnings from the first server must not hide errors from a later server. It aggregates only the requested files and up to `otherFiles` error-bearing files.
- Edit persists only its edited file. Apply Patch selects non-deleted targets, using move destinations. Write retrieves its file plus five other error-bearing files, preserves its existing report rendering, and persists only its own file's diagnostics. Cross-file context survives in the output string, not as redundant structured metadata.
- Existing per-client push/pull deduplication is retained. Cross-server diagnostics are concatenated just as before; this change does not introduce cross-server deduplication.
- The no-argument diagnostics query remains available for the existing debug CLI and full-workspace test oracle. No tool uses it. No public Protocol/HttpApi change or generated-client update is needed.

## Benchmark

Artifacts:

- `packages/opencode/test/fixture/lsp/diagnostic-metadata-server.ts`
- `packages/opencode/test/tool/diagnostic-metadata.bench.test.ts`
- `specs/perf-diagnostic-metadata-before.json`
- `specs/perf-diagnostic-metadata-after.json`

The fixture runs **real EditTool, WriteTool, ApplyPatchTool, LSP service and LSP clients**, with two local stdio JSON-RPC servers. Config/home/database isolation comes from the existing test preload and instance fixtures. Formatting is disabled for the synthetic `.diag` files. No LSP/service implementation is mocked. A service decorator times the real diagnostics query and counts its returned file/diagnostic entries.

Workload: 0, 100, 1,000 and 10,000 unrelated files, each with 24 diagnostics per server. Two fixed files each have an error and a warning per server. The first unrelated file has only warnings on server 0 but errors on server 1. Push and pull both report the affected files, exercising existing deduplication. Write/Edit affect one file; Apply Patch affects two. Each combination has two warmups and seven measured trials: 84 measured calls per side. The same workload, server and tool calls run before and after.

Measured separately:

1. Whole real tool execution time.
2. Real diagnostics retrieval time and returned file/diagnostic counts.
3. Serialized metadata bytes and diagnostic entries retained by metadata.
4. Bytes and `structuredClone` + JSON serialization time for a completed-tool-part-shaped envelope carrying the **actual returned output/title/metadata**. Its IDs/timestamps/input are fixed. This is not a timed Session/database/projector write.

The full temporary directory is replaced with `/fixture` in measured payloads. Existing non-Git instance titles/patch summaries can also contain relative `tmp/opencode-test-*` paths; their random suffix length accounts for a few bytes of variation. Output comparisons additionally canonicalize those relative paths. Raw results retain the original measured values.

### Serialized metadata bytes (median)

| Unrelated files | Write before → after | Edit before → after | Apply Patch before → after |
| ---: | ---: | ---: | ---: |
| 0 | 1,241 → 664 | 1,655 → 1,078 | 2,247 → 2,247 |
| 100 | 693,361 → 664 | 693,775 → 1,078 | 694,367 → 2,247 |
| 1,000 | 6,969,961 → 664 | 6,970,375 → 1,078 | 6,970,965 → 2,247 |
| 10,000 | 70,167,961 → 664 | 70,168,375 → 1,078 | 70,168,967 → 2,247 |

### Work counts

Before, each tool query returns and retains `N + 2` files and `48N + 8` diagnostics. At 10,000 unrelated files, that is 10,002 files / 480,008 diagnostics per call.

After:

| Tool | Query files / diagnostics at N ≥ 100 | Metadata files / diagnostics |
| --- | ---: | ---: |
| Write | 6 / 200 | 1 / 4 |
| Edit | 1 / 4 | 1 / 4 |
| Apply Patch | 2 / 8 | 2 / 8 |

These are counts of returned/retained entries, not instrumented loop-iteration or allocation counts. Write's source can still visit many map keys to preserve report ordering; it does not reconstruct those files' diagnostics.

### Median time and serialized part bytes at 10,000 unrelated files

| Tool | Retrieval ms before → after | Tool ms before → after | Clone + serialize ms before → after | Part bytes before → after |
| --- | ---: | ---: | ---: | ---: |
| Write | 198.534 → 1.082 | 225.460 → 9.339 | 1,459.388 → 0.060 | 70,171,784 → 4,487 |
| Edit | 267.734 → 0.050 | 293.261 → 1.753 | 1,471.489 → 0.054 | 70,168,860 → 1,563 |
| Apply Patch | 217.651 → 0.073 | 253.931 → 2.783 | 1,454.526 → 0.099 | 70,170,280 → 3,560 |

The byte/work reductions are deterministic. Timings include ordinary scheduler/GC noise, and other agents' tests/research could run concurrently. No retained-heap or RSS improvement is claimed: language-server diagnostic caches still exist. The improvement is in repeated query materialization, tool payload retention, cloning and serialization.

## Reproduction and checks

Run all commands from `/tmp/opencode/perf-batch/diagnostic-metadata/packages/opencode`.

Baseline command, executed against the untouched runtime:

```sh
flock --verbose /tmp/opencode/perf-batch/bench.lock env DIAGNOSTIC_BENCH_OUTPUT=/tmp/opencode/perf-batch/diagnostic-metadata/specs/perf-diagnostic-metadata-before.json bun test test/tool/diagnostic-metadata.bench.test.ts
```

After command, executed against the final runtime:

```sh
flock --verbose /tmp/opencode/perf-batch/bench.lock env DIAGNOSTIC_BENCH_OUTPUT=/tmp/opencode/perf-batch/diagnostic-metadata/specs/perf-diagnostic-metadata-after.json bun test test/tool/diagnostic-metadata.bench.test.ts
```

Baseline: 4 pass, 108 assertions, 72.81 seconds test-process duration; lock wait **152.379441 seconds**, excluded from timings. Final after: 4 pass, 108 assertions, 5.70 seconds; lock wait **0.000003 seconds**, excluded. An earlier after run also passed (4.62 seconds; 47.781683 seconds lock wait), then the final after run replaced it after a control-flow cleanup. Do not rerun the baseline command on patched code and mistake that for baseline data.

Regression command:

```sh
bun test test/tool/diagnostic-metadata.test.ts test/tool/write.test.ts test/tool/edit.test.ts test/tool/apply_patch.test.ts test/lsp/lifecycle.test.ts test/lsp/client.test.ts
```

Final result: **103 pass, 0 fail, 207 assertions** (10.56 seconds). New coverage includes normalized/duplicate requested paths, two servers, push/pull deduplication, warnings on the first server and errors on the second, exact bounded Write reporting and overflow counts, multiple patch files, move destinations, deletion exclusion, missing diagnostics, disabled LSP and empty document reports with other-file errors.

All **84 before/after output comparisons passed**, with only fixture directory names canonicalized. This includes Write's report order, error text, five-file bound, 20-error bound and overflow suffixes. To repeat the output/metadata assertions without creating another file:

```sh
bun -e 'import assert from "node:assert/strict"; const a = (await Bun.file("../../specs/perf-diagnostic-metadata-before.json").json()).samples; const b = (await Bun.file("../../specs/perf-diagnostic-metadata-after.json").json()).samples; const normalize = s => s.replaceAll(/tmp\/opencode-test-[^/]+\//g, "fixture/"); assert.equal(a.length, 84); assert.equal(b.length, 84); for (let i = 0; i < a.length; i++) { assert.deepEqual([a[i].tool, a[i].population, a[i].trial], [b[i].tool, b[i].population, b[i].trial]); assert.equal(normalize(a[i].output), normalize(b[i].output)); assert.equal(b[i].metadataFiles, b[i].tool === "apply_patch" ? 2 : 1); assert.equal(b[i].metadataDiagnostics, b[i].tool === "apply_patch" ? 8 : 4); } console.log("84 output and metadata comparisons passed")'
```

The raw JSON includes every individual timing sample and payload byte count. Table timings use the middle of seven sorted samples. Combined package typechecking is deferred to the parent per the performance-agent contract.

## Changed paths and integration overlaps

Runtime:

- `packages/opencode/src/lsp/client.ts`: only new retrieval accessors immediately before the existing diagnostics getter (baseline line 623). **Overlap with lsp-documents agent:** same file/return object, but no notify, push/pull update, document-cache or wait edits. Preserve/adapt these accessors to its cache changes; `diagnosticFiles()` must retain push-then-pull first-seen order and `diagnosticsFor` must retain per-client deduplication.
- `packages/opencode/src/lsp/lsp.ts`: diagnostics service signature and implementation only (baseline lines 124 and 364–375).
- `packages/opencode/src/tool/edit.ts`: diagnostics retrieval and normalized lookup (baseline lines 199–200).
- `packages/opencode/src/tool/write.ts`: retrieval/normalized lookup (76–77), metadata diagnostics (95). Report rendering stays intact.
- `packages/opencode/src/tool/apply_patch.ts`: diagnostics retrieval (271) and normalized report lookup (289). **Overlap with diagnostics-wait agent:** retrieval call is immediately after its wait loop; merge this scoped call with its loop changes. This patch does not change the touch/wait loop at 265–270.

New artifacts:

- `packages/opencode/test/fixture/lsp/diagnostic-metadata-server.ts`
- `packages/opencode/test/tool/diagnostic-metadata.test.ts`
- `packages/opencode/test/tool/diagnostic-metadata.bench.test.ts`
- `specs/perf-diagnostic-metadata-before.json`
- `specs/perf-diagnostic-metadata-after.json`
- `specs/perf-diagnostic-metadata.md`

## Limitations and residual risks

- Write can still scan O(workspace files) keys when the written file occurs late or few files contain errors. Finding the legacy first five error-bearing files requires examining candidates; only the selected files are merged. Edit and Apply Patch use direct file lookups.
- Diagnostics within an affected file remain complete. Transient Write context is bounded by five other files, not by that file's diagnostic count; its rendered output retains the existing bounded reports. None of these other-file arrays are persisted in metadata.
- Tests ran on Linux; Windows path normalization uses the existing FSUtil behavior, but was not executed on Windows.
- The part-size/clone benchmark uses a representative completed-part envelope, not actual database I/O, provider orchestration or end-to-end UI rendering. Input payload size is excluded. The actual tool metadata and output are exercised.
- `/tmp` exhausted its inode quota while an optional summary artifact was being created (1,048,576 / 1,048,576 inodes; byte capacity remained available). Raw before/after results and successful tests were already saved. The temporary comparator script was removed to make room for this required report; its comparison is reproduced inline above. No unrelated files were removed.

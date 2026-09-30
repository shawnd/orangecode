# Off-the-shelf legacy edit distance — integration handoff

## Decision

Use **`leven@4.1.0` (MIT)** directly in `packages/opencode/src/tool/edit.ts`.
One import, two distance call substitutions, and deletion of the old matrix;
no Core wrapper, native fuzzy kernel, routing, capture, calibration, or fallback.
The block-anchor discovery, JS trim, scoring, thresholds, early exits, tie order,
replacement order, and safety checks are unchanged. No distance cap is supplied.

Worktree: `/tmp/opencode/native-fuzzy`, branch `native-fuzzy`, base
`f47dff9ad36a778b1dbd0a99fff6a5a0b2fdf62a`. Main checkout was read only.
No commits, builds, or deployment; final integration/deployment belongs to parent.

## Package evaluation (2026-09-30)

- Existing `fuzzysort@3.1.0` is a ranking metric, not edit distance. No suitable
  existing root-workspace distance dependency was found. A separate VS Code lock
  contains transitive `fast-levenshtein@2.0.6`; that is not an opencode dependency.
- `leven@4.1.0`: npm latest, published 2025-09-11; 10,206 unpacked bytes, native ESM
  and bundled declarations, **zero runtime dependencies**, no install hooks.
  Inspected actual installed `index.js`, `package.json`, and MIT `license`.
  It uses string lengths and `charCodeAt`, exact unit insertion/deletion/substitution,
  and common-prefix/suffix reduction. No normalization, code-point iteration,
  collation, transposition operation, or grapheme conversion. Calls omit `options`,
  so the package's capped-distance/closest-match paths are unused.
- GitHub `sindresorhus/leven`: unarchived, zero open issues at inspection, latest
  push 2026-09-26; recent commits include performance work and a `4.2.0` version
  commit. **4.2.0 was not published on npm** (version endpoint 404; npm `latest`
  still 4.1.0), so pin the available reviewed release, not GitHub main.
- `fastest-levenshtein@1.0.16`: also MIT, zero runtime dependencies, 21,281 unpacked
  bytes; latest release 2022-08-02, latest repository push 2024-03-17, unarchived,
  two open issues. Reviewed upstream implementation: UTF-16 `charCodeAt` Myers
  bitvectors, a permanent 65,536-entry Uint32 table, and multiword machinery.
  Suitable metric, but `leven` has more recent maintenance and affix reduction
  useful to source edits. No claim that `leven` is faster than this alternative;
  measurements below compare the selected installed release with our original.
- `js-levenshtein@1.1.6`: MIT, zero runtime dependencies, latest 2019-01-10;
  inspected its `charCodeAt` implementation but preferred the maintained ESM option.

Sources: npm registry metadata/version endpoints; GitHub repository/commit API;
`https://github.com/sindresorhus/leven`; actual installed package. `gh` lacked
authentication, so repository health was checked with public read-only HTTPS.

## Verification

All commands ran in this worktree, tests/typechecks from package directories:

```sh
# Root: authorized manifest/lock installation
bun install

# packages/opencode
bun typecheck
bun test test/tool/edit.test.ts test/tool/edit-fuzzy.test.ts test/tool/apply_patch.test.ts
# 74 pass, 0 fail, 12,950 assertions
bun run script/bench-edit-fuzzy.ts

# packages/core
bun typecheck
bun test test/tool-edit.test.ts test/tool-apply-patch.test.ts
# 19 pass, 0 fail, 76 assertions
```

Parity uses the unchanged, attributed, portable frozen original oracle
`packages/opencode/test/tool/native-fuzzy-baseline.ts`, not a newly written algorithm:
7,225 exhaustive pairs over ASCII/NUL/high/low surrogate units through length 3;
1,000 seeded full-range UTF-16 cases at bounded lengths through 256 with reverse,
common-affix, and equality checks; saved dense-1024, astral, lone-surrogate,
combining-mark, transposition, and NUL/FFFF cases. Actual exported
`BlockAnchorReplacer` and `replace` retain saved threshold/trim/anchor/newline/tie/
safety cases plus 500 seeded candidate/output/error comparisons. No mocks.

## Measurements

Bun 1.4.2, Linux x64, AMD Ryzen 9 5950X. Run the checked-in benchmark from opencode.
Each case/backend gets a fresh subprocess, importing the same module graph.
Expected outputs are analytical; the package subprocess never executes the matrix.
First-call computation is measured after imports, then 10 warmups and 31 samples.
Small-distance/exact-replacement samples batch 100 calls; others are single calls.
Timing includes package calls and full exported `replace` overhead, not a kernel.
Both outputs are checked. Peak RSS includes the entire legacy import graph.

Representative timings, milliseconds **median / p95** (one host run):

| Case                                      |   Original matrix |  Installed `leven` |            Median gain |
| ----------------------------------------- | ----------------: | -----------------: | ---------------------: |
| kitten/sitting                            | 0.00152 / 0.00491 |  0.00102 / 0.00139 |                  1.50x |
| dense 32                                  |   0.0125 / 0.0287 |  0.00368 / 0.00482 |                  3.39x |
| dense 512                                 |     2.754 / 3.772 |      0.583 / 0.876 |                  4.72x |
| dense 1024                                |   10.065 / 15.828 |      1.922 / 2.345 |                  5.24x |
| scattered 512                             |     2.724 / 3.571 |      0.500 / 0.812 |                  5.44x |
| affix 512                                 |     2.830 / 3.863 |  0.00755 / 0.00947 |                   375x |
| rectangular 128 x 512                     |     0.740 / 1.363 |      0.267 / 0.469 |                  2.77x |
| full replace, 1 scattered-512 candidate   |    9.950 / 13.415 |      2.073 / 3.130 |                  4.80x |
| full replace, 12 scattered-512 candidates | 117.681 / 130.289 |    21.933 / 27.573 |                  5.37x |
| full replace, 12 affix-512 candidates     | 128.197 / 166.094 |      0.130 / 0.252 |                   983x |
| exact replacement (no distance needed)    | 0.00106 / 0.00222 | 0.000855 / 0.00202 | noise-level difference |

Dense-512 first computation: 19.31 -> 2.61 ms; 12-candidate scattered replacement:
190.19 -> 31.61 ms. Empty first computation was slower (0.066 -> 0.157 ms), so this
does not claim universal cold-call improvement or include module startup timing.
Twelve-candidate scattered peak RSS: 448,876 -> 183,600 KiB. Affix-heavy gains
reflect avoiding the original full matrix and should not be generalized to dense
inputs. JIT, GC, and shared-machine noise affect absolute timings.

## Exact integration manifest

Integrate only these tracked changes/new files:

1. `packages/opencode/src/tool/edit.ts` — direct package call; remove original matrix.
2. `packages/opencode/package.json` — runtime dependency `"leven": "4.1.0"` only.
3. `bun.lock` — **three added lines only**: opencode workspace dependency and one
   resolved `leven@4.1.0` package record (plus its separator). No Core lock changes.
4. `packages/opencode/test/tool/edit-fuzzy.test.ts` — original-behavior/package parity.
5. `packages/opencode/test/tool/native-fuzzy-baseline.ts` — keep frozen oracle unchanged.
6. `packages/opencode/script/bench-edit-fuzzy.ts` — real package/real replacer benchmark.
7. `specs/edit-distance-results.md` — this report.

Removed owned experiment files (previously untracked; omit them from integration):

- `packages/core/native/src/fuzzy.rs`
- `packages/core/src/native/fuzzy.ts`
- `packages/core/test/native/fuzzy.test.ts`
- `packages/core/bench/native-fuzzy.ts`
- `specs/rust-native-fuzzy-results.md` (superseded by this report)

**Borrowed exclusions: leave untouched and omit entirely from fuzzy integration.**
They have no role in the chosen implementation:

- `packages/core/package.json` (borrowed `#native-acceleration` imports addition)
- `packages/core/native/Cargo.toml`, `Cargo.lock`, `README.md`, `src/lib.rs`
- `packages/core/script/build-native.ts`
- `packages/core/src/native/types.ts`, `binding.bun.ts`, `binding.node.ts`, `artifact.ts`
- `packages/core/test/native/abi.test.ts`, `artifact.test.ts`
- `specs/rust-native-acceleration.md`
- Ignored native build outputs/targets and all `node_modules`.

Borrowed foundation `lib.rs` still declares the optional `fuzzy` module. Its owned
implementation was removed as requested; do not build that abandoned feature or
copy these foundation files with this track. Foundation ownership/cleanup belongs
to parent. This track neither edits the borrowed ABI nor claims its native tests.
All 13 borrowed file SHA-256 hashes were verified unchanged before and after this
work, as was the frozen oracle (`2c70eb540c3266c6ff2fad4811895bf7b83f5ca3857a3416bf8ea8b6668275a3`).

## Remaining considerations

- `leven` is synchronous; large unrelated strings still require quadratic work,
  although space is linear rather than the original matrix. No scheduler or cap.
- The package uses two shared private arrays, reused synchronously with primitive
  strings and no callbacks. Completed nontrivial calls resize them to current
  shorter input length; fast-return calls do not necessarily release prior buffers.
- Do not add a distance cap or switch to `closestMatch`: exact numeric distances
  feed unchanged floating-point scoring and early-exit decisions.
- Final combined build/deployment and other platforms remain parent verification.

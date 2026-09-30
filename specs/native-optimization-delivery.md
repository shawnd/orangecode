# Performance delivery — September 30, 2026

## Enabled changes

- Legacy fuzzy edits use the existing `leven@4.1.0` package (MIT, no runtime dependencies), preserving UTF-16 distance and existing matching/scoring rules. Representative measured dense/full-replacement fixtures improved roughly 4.7–5.4 times over the original matrix implementation.
- Core edit/apply-patch summarize changes with one public `diff` package computation instead of separate patch/count computations. Representative prior 1 MiB ordinary-edit measurement: 17.470 ms to 8.604 ms median.
- FFF filesystem search has lazy initialization, real ripgrep availability fallback, and scoped cleanup. Ripgrep directory arrays are materialized on consumption rather than copied for every scanned file.
- Worker-backed FFF is packaged but opt-in: `OPENCODE_EXPERIMENTAL_FFF_WORKER=1 oc`. Native FFF remains direct by default. Worker caller-loop p95 improved from approximately 87 ms to 1 ms on the measured 100k-file fixture, but large distinct-line result pages missed the latency gate.

No custom fuzzy kernel or experimental native diff infrastructure is part of this delivery. The Rust diff prototype remains in `/tmp/opencode/native-diff`; it did not meet the automatic-routing performance gate. Main's independently developed native reminders infrastructure was preserved.

## Verification

Independent reviews approved the actual shipping changes. Both Core and opencode package-local typechecks passed. Relevant suites include:

- Legacy edit/fuzzy/apply-patch: 74 tests, 12,950 assertions.
- Core one-pass diff/edit/apply-patch: 23 tests, 2,271 assertions.
- Search/worker/Core tools: 57 tests, 540 assertions in each native mode.
- Final integrated worker suite with diff: 61 tests, 2,735 assertions.

These suites overlap; counts must not be summed as unique tests. Tests cover UTF-16/surrogates, original replacer behavior, exact patch bytes/counts, default/worker/disabled routing, actual native results, initialization interruption, bounded request admission, cancellation, fallback and destruction acknowledgement.

The compiled helper ran with source checkouts, worktrees and developer dependencies inaccessible. It verified `fff-worker`, `file:///$bunfs/root/opencode-fff-worker.js`, filename/grep results, and acknowledged destruction/closure.

The final production executable ran twice under bubblewrap, once default-direct and once worker-opt-in. Both completed a real session with read/edit/apply_patch and returned the fixture from `/api/fs/find`. The mapped FFF library matched the installed artifact hash; fallback warnings failed the test. The worker thread appeared only in opt-in mode. These final tests ran against the exact deployed binary snapshot.

Verified platform/runtime: Linux x64 glibc, Bun 1.4.2. Other platforms and pinned Bun 1.3.14 were not certified for the final integrated search delivery.

## Build and deployment

From `packages/opencode`:

```sh
bun run script/build.ts --single --skip-install --skip-embed-web-ui
```

Build passed, including the existing native reminders plugin. The parent reran both hermetic production scenarios against a retained copy of this fresh build, then atomically replaced `~/.local/share/oc/bin/opencode`.

- Version: `0.0.0-shawnd-202609300746`
- SHA-256 of build and deployed executable: `5c75aaade37f31eb0d9a30b002546b19084fcef6d7f282e7dc63c0df98babf12`
- Retained verified snapshot: `/tmp/opencode/search-integration/opencode-final`
- `oc --version` and byte identity with the build passed after installation.
- Running sessions need a restart to load the new executable.

Reproduction helpers and controller are in `/tmp/opencode/search-integration/`. Detailed measurements and limitations are in `edit-distance-results.md`, `one-pass-diff-results.md`, and `rust-native-search-results.md`. Implementation worktrees are retained. Implementation and deployment did not create a commit; the subsequent session-only commit request is covered below.

## Isolated pre-commit verification

After the user requested a session-only commit, its staged source was checked independently of unrelated working-tree changes, against baseline `77edb1fc71`:

- Core diff/search/tool suite: 61 tests and 2,735 assertions passed in both default-direct and worker-opt-in modes.
- Legacy edit/fuzzy/apply-patch: 74 tests and 12,950 assertions passed.
- Core typecheck passed.
- Opencode typecheck reports `dialog-usage-stats.tsx:31` accessing missing `globalClient`. The identical error was reproduced on the unchanged baseline source. The working checkout contains a separate, uncommitted SDK change that addresses it; that unrelated change is excluded from this commit.

One extra run exhausted temporary filesystem inodes during a disposable dependency installation. The temporary install was removed and the affected worker-mode tests rerun successfully. No session code was changed to address that environmental failure.

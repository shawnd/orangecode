# One-pass Core diff summaries

## Delivered scope

Core edit and apply-patch now share `Diff.summarize(file, before, after)`.
It uses the existing public `diff` package (8.0.2): one `structuredPatch` call,
counts additions/deletions from hunk line prefixes, then one `formatPatch` call.
This removes the former separate `diffLines` traversal for counts.

The helper has no custom diff algorithm, native imports, mode flags or routing.
Edit prepares the summary at the former pre-write counts boundary;
`FileMutation.writeIfUnchanged` returns `target.resource` unchanged, preserving
patch headers. Apply-patch still prepares summaries before sequential writes.
Existing exact matching, permissions, stale-write checks and mutation order stay
in place.

Exact main delivery manifest:

```text
packages/core/src/util/diff.ts
packages/core/src/tool/edit.ts
packages/core/src/tool/apply-patch.ts
packages/core/test/util/diff.test.ts
specs/one-pass-diff-results.md
```

## Verification in main

From `packages/core` on Bun 1.4.2:

```sh
bun test test/util/diff.test.ts test/tool-edit.test.ts test/tool-apply-patch.test.ts
bun typecheck
```

**23 tests passed, 2,271 assertions; Core typecheck passed.** Focused parity
compares entire patch strings and counts against the original two-call baseline.
Coverage includes empty/unchanged/add/delete, EOF newlines, LF/CRLF/bare CR,
BOM/NUL/Unicode/lone surrogates, unusual headers, overlapping/distant hunks,
eight-versus-nine context gaps, 500 seeded repeat-rich pairs and 1,600 exhaustive
short line/EOF pairs. Applicable patches are applied; newline-containing headers
retain the baseline's parser rejection as well as identical patch bytes.

Opencode `bun typecheck` was attempted during concurrent fuzzy integration and
reported only missing `leven` and `native-fuzzy-baseline` imports in that owner's
legacy edit, benchmark and test files. Those unrelated files were not modified.

## Existing measured evidence

These are **previous prototype measurements**, not a fresh main benchmark run.
The main helper uses the same one-pass public-package implementation measured in
the frozen `/tmp/opencode/native-diff/specs/rust-native-diff-results.md` report.
The full-pipeline matrix used fresh processes, warmup, 31 timed calls per case,
and deterministic fixtures. Representative ordinary-edit timings in milliseconds:

| Fixture | Original median / p95 | One-pass TS median / p95 |
| ------- | --------------------: | -----------------------: |
| 1 KiB   |         0.051 / 0.129 |            0.032 / 0.069 |
| 32 KiB  |         0.452 / 0.880 |            0.362 / 0.641 |
| 256 KiB |         5.201 / 7.590 |            2.167 / 3.776 |
| 1 MiB   |       17.470 / 24.288 |           8.604 / 11.444 |

The subsequent 300-pair comparison, including the prototype's auto adapter,
recorded one-pass TS p95 ratios of 0.451–0.673 versus the original baseline.
These measurements support the one-pass TS change; they do not claim universally
faster inputs or new main-checkout measurements.

Native diff failed its automatic-enablement speed gate and remains an unshipped,
frozen prototype. Main's native reminders crate, loader, build scripts, manifests
and ABI were untouched. No production build, deployment or commit was performed;
parent owns final combined verification and deployment after search integration.

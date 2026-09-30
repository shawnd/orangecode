# OpenCode startup performance and fast-input findings

**Date:** September 30, 2026

**Scope:** Local `oc` CLI/TUI startup, editable input, landing-page continuity, slash commands, model selection, and terminal ownership.

**Evidence:** Investigation, implementation, tests, and native PTY/tmux measurements recorded in this conversation.

## Executive summary

The original installed CLI required approximately **4.7 seconds** before its prompt was available. An independent early-input worker reduced time to editable input to approximately **40 milliseconds**, while the application continues loading.

The fast interface now shares landing-page geometry and autocomplete presentation with the live TUI. It displays cached model, provider, variant, and agent metadata; preserves colors and bold styling; supports mouse cycling; and opens the real model dialog while discovery is still running.

A reproducible startup failure was traced to a delayed notification reading a destroyed textarea after input handoff. Follow-up investigation also confirmed input loss across modal-close boundaries, dropped cold-cache model selections, and missing support for xterm modified-Enter sequences. These findings led to targeted fixes and regression coverage.

At the final verification point recorded in the conversation:

- The previous completion summary reported **101 focused tests passed**, and both affected package typechecks passed. The retained investigation record explicitly confirms 63 CLI tests; the complete final TUI test output was not retained, so the combined total is a historical summary rather than an independently reconciled count.
- The original crash reproducer survived **eight launches** after its fix.
- The deployed `oc` command accepted input in **40–46 ms** across two measured runs.
- The real model picker appeared approximately **1.05 seconds** after launch in a native run.
- An isolated provider test verified one explicit prompt request containing the expected multiline text.

These results describe the verified builds from this investigation. The working tree also contained concurrent changes from other work; they are not all attributable to this effort.

## 1. Objectives and constraints

The requested startup experience was:

1. Accept typing immediately, independently of application initialization.
2. Preserve text, Unicode boundaries, paste, and cursor position through handoff.
3. Keep prompt placement, theme, and typography consistent across loading stages.
4. Show useful landing-page metadata before full discovery completes.
5. Provide the same styled slash-command popup and access to the real model picker.
6. Extend the mouse interactions introduced by commit `4056b00adbca412ced38cf08d1705fa7e6ecea6c` into fast input.
7. Match the live input's submit and newline bindings.
8. Restore terminal state correctly on cancellation, failure, and shutdown.

The early path must remain lightweight. Loading full configuration, provider catalogs, plugins, or the application runtime before accepting input would defeat the main improvement.

## 2. Baseline bottlenecks

### Initial measurements

| Launch path   | Initial prompt availability |
| ------------- | --------------------------: |
| Installed CLI |   Approximately 4.69–4.75 s |
| Source launch |        Approximately 5.55 s |

### Findings

- **Eager command imports:** Starting the default TUI evaluated code belonging to other CLI commands.
- **Blocking terminal/theme discovery:** Initial rendering could wait for terminal palette replies.
- **Large provider catalog:** The complete `/provider` response was approximately **6.46 MB**.
- **Duplicated location initialization:** Compatibility and newer API paths could construct separate service graphs for the same location.
- **Repeated refresh work:** Overlapping consumers performed redundant data refreshes.
- **Serialized startup work:** TUI configuration loaded before backend-worker creation, followed by sequential UI/runtime imports.
- **Discovery remained on the usable-prompt path:** Connected-provider and agent initialization still had to complete before normal submission.

A later source profile recorded approximately **529 KB** for `/config/providers` and **50 KB** for `/agent`. In that run, the respective RPC durations were approximately **752 ms** and **1,263 ms**. These measurements identify substantial discovery work; they do not isolate every internal cost.

## 3. Implemented startup architecture

### Three presentation stages

| Stage           | Renderer                                            | Input ownership                 |
| --------------- | --------------------------------------------------- | ------------------------------- |
| First frame     | Lightweight ANSI rendering in an independent worker | Early editor in that worker     |
| Intermediate UI | OpenTUI/Solid `EarlyPrompt`                         | Early editor on the main thread |
| Live prompt     | Normal home/session prompt                          | Normal TUI input and keymap     |

The independent worker prevents synchronous application imports on the main thread from freezing typing. Its functions are serialized into a data URL to avoid importing the application's shared runtime bundle into the first-input path.

**Important implementation constraint:** Serialized functions must be self-contained. References to imported runtime bindings or other unserialized module closures can fail inside the worker.

### CLI and backend improvements

- Added a small entrypoint that starts early input before importing CLI orchestration.
- Made command selection and loading lazy.
- Deferred the complete provider catalog; connected-provider data supplies initial usability.
- Shared location-service initialization and normalized equivalent absent/undefined workspace placement.
- Coalesced overlapping refreshes.
- Started the backend worker before loading TUI configuration.
- Overlapped independent configuration reads and UI/runtime imports.
- Added advisory provider/agent warmup while the renderer loads. Normal bootstrap requests remain authoritative.

### Fast-path eligibility

The investigated fast path handles fresh, interactive local launches, including explicit directory paths and supported safe boolean flags. Resume, mini, non-TTY, Windows, help/version, and ambiguous invocations were excluded from early capture.

## 4. Visual continuity and cached metadata

### Shared geometry

The raw frame, intermediate view, and live home share lightweight geometry and the same logo data. A shared `HomeFrame` aligns the Solid views.

Verified text origins included:

| Terminal / draft                | Text origin, one-based |
| ------------------------------- | ---------------------- |
| 120×40, one line                | Row 21, column 27      |
| 80×24, three lines              | Rows 11–13, column 7   |
| 60×18, wrapped input            | Row 7, column 6        |
| 40×16, three lines              | Rows 7–9, column 6     |
| 120×40, cached 90-column prompt | Row 21, column 19      |

The original raw prompt began near row 3, column 3, which caused a substantial transition shift.

### Presentation cache

The display snapshot is stored at:

```text
${XDG_STATE_HOME || "$HOME/.local/state"}/opencode/startup-presentation.json
```

It contains presentation data and compact selection/control metadata, including:

- Theme colors, cursor style, and prompt/layout dimensions.
- Last-known agent, model, provider, and variant labels.
- Stable agent and variant colors.
- Directory-scoped slash-command descriptors and action identities.
- Compact model/variant and agent options for mouse-control previews.
- Submit and newline bindings.

The snapshot does **not** store prompt contents, credentials, command templates, or session transcripts. Read-only labels are identified as cached until live state takes over. Directory matching prevents another project's selection/catalog from being used as this project's snapshot.

Reads are bounded, validate the record, and reject non-regular files. Nonblocking open behavior prevents an accidental FIFO from holding startup input hostage. Missing or invalid records fall back immediately. Writes are coalesced and atomic; oversized control data is omitted or reduced to stay within the read budget.

### Colors and typography

The first metadata implementation flattened the row into one text color. That did not match the live prompt, particularly the variant label.

The corrected representation uses semantic segments:

| Content                              | Style                      |
| ------------------------------------ | -------------------------- |
| Agent / Build / Plan                 | Resolved agent color       |
| Model                                | Normal foreground          |
| Provider, separators, auto indicator | Muted foreground           |
| Variant, including `default`         | Warning color and **bold** |

The same segments drive ANSI and Solid rendering. Bold is reset after the raw metadata row so it does not leak into subsequent content. The live metadata's initial fade is suppressed for fast-start sessions to avoid flashing darker colors during ownership transfer.

## 5. Slash commands and the real model picker

### Autocomplete

The live and intermediate views share `AutocompleteList`, including:

- Split borders and placement above the prompt.
- Menu background, selected-row background, and selected foreground.
- Command descriptions and padding.
- Keyboard navigation, completion, dismissal, and mouse selection.

The raw ANSI stage implements the equivalent presentation using the cached palette and geometry. A cold-start builtin list supplies common commands; subsequent launches use cached reachable UI commands and server-command descriptors.

Startup filtering uses a self-contained lightweight matcher. The live autocomplete continues using its normal fuzzy-search implementation. Matching aliases as a joined string fixed an observed `/mo` result-count difference that moved the popup by one row at handoff. These matchers should not be assumed to produce identical rankings for every possible query.

### Selection semantics

- Selecting a builtin UI command records an explicit intent; cached records never contain executable callbacks.
- Deferred actions are reconciled against the live reachable command registry.
- Completing a server/custom command inserts its text without submitting it.
- Explicit submission of a cached server command waits for the live command registry rather than guessing that the text should become an ordinary model prompt.
- Unavailable model choices do not cause a queued prompt to silently submit through a different model.

### Actual model dialog

`/model` and `/models` open the actual `DialogModel` component when renderer and UI contexts are available. Compact cached options supply initial rows; live discovery replaces them reactively.

This required separating **context mounting** from **data readiness** for fast starts. Eager mounting does not make `sync.ready` true or allow ordinary submission before readiness.

While the model dialog is open:

- Native dialog input owns keyboard events.
- The early editable overlay is hidden.
- Final prompt handoff is blocked.
- Closing the dialog returns input to the early editor.
- Model choices are retained and applied through the normal live selection methods.

The native model dialog appeared at approximately **1.05 s** in a recorded run. The raw editable frame remains available substantially earlier.

## 6. Mouse UX from commit `4056b00`

The referenced commit introduced:

- Left-click forward and right-click backward cycling through the selected provider's models.
- Forward/reverse variant cycling through `default` and available variants, with wrapping.
- Clickable agent and provider labels.

Fast input previews these interactions from compact cached control data and records directional actions. At handoff, actions are replayed through the live handlers in order. This preserves current model validation and live selection semantics.

The raw stage enables supported mouse reporting and uses rendered field hit regions. The intermediate UI uses native text handlers. Mouse and keyboard protocol settings are released during takeover and cleanup.

Cached catalogs are bounded and may be stale or unavailable. In those cases, preview information can be incomplete; live data and validation remain authoritative.

## 7. Confirmed failures and fixes

### 7.1 Destroyed textarea after slash-popup handoff

**Reproduction:** Start the CLI, type `/`, and repeatedly press Down while startup completes.

The subagent reproduced `EditorView is destroyed` in **8/8 native launches**. Typing `/` once and waiting, or leaving startup idle, survived the control runs.

**Failure chain:**

1. Input capture scheduled a notification after 40 ms.
2. `claim()` deactivated the early interface without clearing that timer.
3. Hiding the view caused OpenTUI to destroy its textarea on a subsequent tick.
4. The component's retained subscription/computations remained active.
5. The delayed notification recomputed layout through `virtualLineCount` on the destroyed editor.

**Fixes:** Clear and guard pending timers at ownership transfer; unsubscribe on final deactivation; clear retained input/scroll references; and guard inactive or destroyed renderable access.

Regression coverage includes late notifications and resizing after destruction. The native reproducer subsequently survived eight launches.

The reproduced application failure was a JavaScript lifecycle exception. Native core dumps observed during investigation belonged to separate startup-layout test failures and were not the confirmed cause of this popup failure.

### 7.2 Text and paste loss when closing a modal

**Reproduction:** Send Escape and following text in one input chunk, or Escape followed by a fragmented bracketed paste.

Forwarding the entire chunk to the native modal lost the remaining text after Escape closed it. In the paste case, the early editor later received the end marker without ever receiving the start marker.

**Fix:** Forward modal input at event boundaries and stop when the native event closes the modal. Route the remaining bytes to the early editor, preserving paste/UTF-8 parser ownership. Modal opening also waits for the early editor to be settled.

Real PTY checks preserved both `TAIL_MARK` and `PASTE_MARK` across these boundaries.

### 7.3 Cold-cache model selection discarded

The model-selection method originally returned when cached selection metadata was absent. This discarded a valid choice made in the native dialog during a first launch.

**Fix:** Record the explicit selection while input is active; update cached display labels only when presentation data is available. A cold-cache PTY check confirmed that the `select-model` action survives handoff.

### 7.4 Modified Enter silently ignored

Kitty modified-key events worked, but xterm `modifyOtherKeys` sequences were initially ignored:

```text
Shift+Enter: ESC[27;2;13~
Ctrl+Enter:  ESC[27;5;13~
Alt+Enter:   ESC[27;3;13~
```

**Fix:** Decode both encodings and resolve them through the live submit/newline bindings. Fragmented-input tests cover modified Enter across handoff boundaries.

### 7.5 Production bridge wiring

Follow-up review found that the fast model-dialog bridge had a test caller but no production caller at that verification point. Its production import/call was restored, and the native model-picker check then exercised the fast-phase dialog rather than waiting for the ordinary prompt.

## 8. Final input behavior

The implementation initially treated Enter as a newline during loading to avoid submission. The user's later instruction explicitly superseded that behavior.

The final behavior follows the live input bindings:

- **Enter:** choose an open slash suggestion or request submission.
- **Shift+Enter, Ctrl+Enter, Alt+Enter, Ctrl+J:** insert a newline with the default bindings.
- **Before readiness:** retain an explicit submission request and use the normal prompt path when ready.
- **Paste:** preserve pasted newlines as text; pasted control bytes do not invoke commands.

An isolated native test used a local provider endpoint and sent a prompt during startup. It observed **one conversation prompt request** with:

```text
first
second
third
```

A separate automatic title-generation request was also observed. That auxiliary request was not a duplicate prompt submission.

## 9. Performance evidence and interpretation

| Investigation phase                           | Measurement                                               |
| --------------------------------------------- | --------------------------------------------------------- |
| Original installed CLI                        | Prompt available in approximately 4.7 s                   |
| Earlier immediate-input deployment            | First input 34.64–38.11 ms; first edit 36.37–40.04 ms     |
| Earlier immediate-input deployment            | Full prompt approximately 2.64–2.72 s                     |
| Layout/theme continuity pass                  | Most measured first-input runs approximately 36–43 ms     |
| Native side-by-side overlap/warmup comparison | Full prompt median 2.75 s → 2.56 s                        |
| Final real model-dialog check                 | Picker visible at approximately 1.05 s                    |
| Final deployed `oc`, two PTY runs             | First input 40.10 / 45.56 ms; first edit 42.39 / 48.07 ms |

### Measurement limitations

- Initial editable input, renderer availability, and ready-to-submit state are different milestones.
- Concurrent builds, tests, other launches, and unrelated code changes affected measurements. One concurrent benchmark recorded a 64 ms median first-input time and substantially slower full startup; this was not sufficient to attribute a regression to one change.
- The layout/theme pass observed a small median overhead of approximately **3–6 ms**. Zero added latency was not established.
- ANSI differential rendering split visible shortcut strings across writes. An early benchmark's string-based full-prompt detector consequently reported false timeouts despite successful rendering. Later marker-based full-prompt figures are not directly comparable to the original detector without a rendered-screen or ownership-aware measurement.
- The final 40–46 ms deployed result covers two runs and is not a broad percentile or cold-system guarantee.

## 10. Verification and deployment

Verification covered:

- Native PTY and tmux startup, typing, editing, and cleanup.
- Unicode/grapheme boundaries, multiline paste, and middle-cursor continuity.
- Shared geometry across sizes, wrapping, scrolling, and resizing.
- Cache validation, directory matching, bounded reads, and atomic writes.
- Slash navigation, selection, and selected-item preservation at handoff.
- Metadata colors, bold variant rendering, and mouse cycling.
- Actual model-dialog rendering while provider discovery is deliberately stalled.
- Late notifications against destroyed renderables.
- Modal-close text/paste boundaries and cold-cache selection.
- Kitty and xterm modified Enter.
- Explicit startup submission through an isolated local provider.

The retained investigation record confirms **63 CLI tests passed** and records successful focused TUI checks. The previous completion summary reported 101 passing tests overall, but the complete final TUI output was not retained; an exact TUI subtotal cannot be independently reconciled from this context. Both affected package typechecks passed at that verification point. Some broader fixture runs emitted teardown/persistence diagnostics while temporary directories were removed; these should be distinguished from the reproduced application crash.

### Pre-commit recheck in the concurrently edited working tree

A subsequent run of eight relevant TUI test files passed **50 tests** and failed **two** newly added `send now` tests. The startup-specific tests in that run passed. The failures concerned attachment submission and interruption-error display, outside the startup change scope.

Fresh package typechecks also encountered errors in concurrent work: a missing `sessionID` in the `send now` event fixture, and a session prompt test referencing a nonexistent `enqueue` method. These results superseded the earlier working-tree verification and prompted the isolated checks below.

### Isolated commit verification

The final startup selection was materialized in a separate worktree from base `8998889ef371334ad9508646ea1a3cff797efa1e`, with workspace dependency links rebound to that worktree. Unrelated working-tree changes were excluded. A read-only background review confirmed the scope and identified a mixed-test hunk-placement error; the snapshot was reconstructed from baseline line coordinates before final verification.

Final isolated results were **108 passing tests, zero failures**, across 16 files:

| Coverage                                                                                 | Passing tests |
| ---------------------------------------------------------------------------------------- | ------------: |
| Early editor/input, lazy CLI, CLI orchestration, and HTTP location sharing               |            64 |
| Startup draft/cache/controls/layout, refresh coalescing, synchronization, and data       |            31 |
| Fast model picker, mouse replay, slash adoption, cached selection, and metadata controls |             7 |
| Renderer/takeover startup-failure cleanup                                                |             2 |
| Location-layer identity and invalidation                                                 |             4 |

`bun typecheck` passed separately in `packages/core`, `packages/opencode`, and `packages/tui` against this isolated selection. The metadata run still emitted temporary-fixture persistence/lock cleanup diagnostics, with no failed assertions. These are focused results, not a claim that every unrelated test in the working tree passes.

Implementation was committed separately as `937a2992cc` (shared location initialization) and `b86cb8471e` (immediate-input CLI/TUI startup). The report is a third commit. Unrelated staged and unstaged work was preserved.

The standard native build command was:

```bash
# Run from packages/opencode
bun run script/build.ts --single --skip-install --skip-embed-web-ui
```

The verified native artifact was installed using an atomic replacement at:

```text
~/.local/share/oc/bin/opencode
```

The native performance measurements above used **`0.0.0-shawnd-202609300843`**. After isolated commit verification, the selected snapshot was rebuilt with `OPENCODE_CHANNEL=shawnd` and deployed as **`0.0.0-shawnd-202609301113`**. The explicit channel preserves the local branch identity when building from a detached verification worktree.

`oc --version`, `cmp`, and identical SHA-256 hashes verified the installed artifact:

```text
aeb75af2b9cdb1b384fcb0a23d66cc92712fdad7ee65f621caeff88bbdf352f5
```

The later deployment was not rebenchmarked, so it does not establish new latency figures. Running sessions require a restart to load it.

## 11. Main implementation locations

| Area                                        | Files                                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Minimal entrypoint and lazy CLI             | `packages/opencode/src/index.ts`, `src/cli/main.ts`, `src/cli/commands.ts`, `src/cli/lazy.ts`                               |
| Early input and terminal ownership          | `packages/opencode/src/cli/early-input.ts`, `src/cli/early-editor.ts`                                                       |
| Backend overlap and warmup                  | `packages/opencode/src/cli/cmd/tui.ts`, `src/cli/tui/worker.ts`                                                             |
| Lightweight presentation/cache/control data | `packages/tui/src/startup/`                                                                                                 |
| Shared home layout and intermediary view    | `packages/tui/src/component/home-frame.tsx`, `src/component/early-prompt.tsx`, `src/routes/home.tsx`                        |
| Shared slash popup                          | `packages/tui/src/component/prompt/autocomplete-list.tsx`, `src/component/prompt/autocomplete.tsx`                          |
| Real fast-phase model picker                | `packages/tui/src/component/startup-model-dialog.tsx`, `src/component/dialog-model.tsx`, `src/app.tsx`                      |
| Live selection and handoff                  | `packages/tui/src/component/prompt/index.tsx`, `src/context/local.tsx`, `src/context/prompt.tsx`, `src/context/runtime.tsx` |
| Readiness and theme                         | `packages/tui/src/context/helper.tsx`, `src/context/sync.tsx`, `src/context/theme.tsx`                                      |

Paths in the latter column following a package prefix are relative to that package. Several files also contain unrelated concurrent work.

## 12. Remaining opportunities

1. **Smaller authoritative bootstrap responses.** Resolve the selected model and primary-agent summaries first, then load complete catalogs and richer metadata. This is the highest-value next target from the recorded profile.
2. **More lazy TUI loading.** Keep chat views, infrequently used dialogs, and other heavy dependencies off the initial landing-page import path.
3. **Discovery caching with invalidation.** Reduce repeated skill/reference directory discovery while preserving authoritative permission and execution behavior.
4. **Ownership-aware performance instrumentation.** Measure first editable input, renderer readiness, model/agent readiness, and actual prompt ownership separately rather than inferring them from emitted words.
5. **Autocomplete parity.** Test a wider query set against startup and live matching, especially aliases, descriptions, Unicode, and changing catalogs.
6. **Extended modal-boundary coverage.** Exercise large pastes, additional terminal encodings, rapid open/close cycles, and input batches spanning readiness transitions.
7. **Submission batching semantics.** Explicit startup submission was verified for a single retained draft. Rapid multiple submissions and typing after a queued Enter deserve separate coverage before claiming full equivalence to the live session workflow.

The investigation did not establish a need for FFI in the first-input path. Lightweight display snapshots, reduced initialization work, and improved concurrency addressed the observed bottlenecks directly.

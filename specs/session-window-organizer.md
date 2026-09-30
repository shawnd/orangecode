# Session Window Organizer

## Summary

Add a **Organize Sessions** control immediately to the right of the existing **New Tab** button. It analyzes the user's existing sessions, recommends which sessions belong together in a window, and lets the user review and apply the organization.

The feature should reduce tab clutter without silently moving sessions based on weak guesses. It must distinguish sessions that share a repository from sessions working on the same task: repository affinity is useful grouping evidence, but does not prove that two sessions are part of one task.

## Problem

Users can have many active or resumable sessions spread across tabs and windows. Finding related sessions and arranging them is currently manual. Tab titles alone are often incomplete, and a user must inspect each conversation to understand whether sessions are related.

In a representative set of sessions, analysis found:

- **Git diff review** and **Show OpenCode session title in agents sidebar** both belong to the `opencode` project and are reasonable candidates for the same project window. Their tasks are distinct, so the relationship should be labeled project affinity rather than shared-task certainty.
- **Background mode for subagent tasks** also belongs to `opencode`, but concerns async prompt execution and scheduling; it is a separate runtime task and may merit its own group.
- **ParadeDB vectorstore Postgres integration** concerns `recall-mono`, not `opencode`, and should stay separate.

This illustrates why organization needs inspectable evidence and user review rather than grouping by title or repository alone.

## Goals

- Make session organization discoverable beside **New Tab**.
- Analyze available session metadata and conversation context to recommend useful window groups.
- Explain why each session is grouped, including confidence and evidence.
- Let users adjust recommendations before applying them.
- Make applying a plan predictable, reversible where practical, and safe for active sessions.
- Keep session contents private to the local organization flow; do not transmit them to an external service without explicit product-level consent.

## Non-goals

- Automatically merge conversations, messages, worktrees, or session state.
- Assume sessions are related solely because they use the same repository, agent, model, or provider.
- Automatically move sessions without user confirmation.
- Replace ordinary manual tab/window management.
- Infer that a session is safe to close or delete.

## User experience

### Entry point

Place **Organize Sessions** directly to the right of **New Tab** in the session/tab navigation surface. Use an icon plus accessible label or tooltip consistent with neighboring controls. The action should be available when there are enough sessions to organize; disabled/empty-state behavior should be explicit.

### Review flow

1. The user opens **Organize Sessions**.
2. The UI gathers eligible sessions and analyzes their metadata and relevant conversation summaries.
3. A review view presents proposed windows/groups, their names, included sessions, and any sessions left ungrouped.
4. Each proposed relationship includes a concise rationale and a confidence indicator. Evidence should identify signals such as shared project/repository, overlapping task intent, shared worktree/branch, or explicit references between sessions.
5. The user can rename groups, move sessions between groups, ungroup sessions, and exclude sessions.
6. **Apply organization** performs only the reviewed layout changes. A cancel action leaves the current layout untouched.
7. After applying, provide an undo/revert affordance for the organization operation when supported by the existing navigation model.

### Recommendation language

Use relationship labels that make the distinction clear:

- **Same task**: strong evidence of a shared objective or direct continuation.
- **Same project**: shared repository/project, but task relationship is weak or unknown.
- **Possibly related**: partial evidence; present as a suggestion, not a default grouping.

Avoid describing a group as certain when evidence is only a common repository or workspace.

## Analysis behavior

### Inputs

Use the least data needed to generate useful recommendations, preferring structured metadata:

- Session title and user-provided description.
- Project/repository identity and working directory.
- Worktree, branch, and remote identity when available.
- Recent user prompts and concise session summaries.
- Explicit links, references, or parent/child session relationships when available.
- Existing window/tab placement as a weak continuity signal, not proof of affinity.

Do not use model/provider identity or agent status as primary affinity signals. Working/idle status may inform presentation, but must not imply that two sessions belong together.

### Output

Produce a proposed organization with:

- Named groups representing windows or other top-level session collections.
- Session membership, including an explicit ungrouped section.
- A relationship type and confidence for each grouping recommendation.
- Human-readable rationale tied to observable evidence.
- A clear indication when analysis could not inspect enough context.

The analysis should prefer a small number of high-quality recommendations over forcing every session into a group. It must be deterministic about applying the user-reviewed plan even if recommendation generation uses a model.

### Safety and privacy

- Do not move, close, rename, or otherwise mutate sessions during analysis.
- Do not start or message agents as part of analysis.
- Do not include secrets or unrelated full transcript history in prompts or diagnostics.
- If an LLM is used, follow the product's existing data-handling and model-consent behavior; make the analysis source clear to the user.
- On cancellation, timeout, or analysis failure, preserve the current layout and show an actionable error or fallback.

## Functional requirements

1. The organizer is accessible immediately to the right of **New Tab**.
2. It discovers eligible sessions across the current user's relevant session scope and clearly identifies the scope being analyzed.
3. It provides recommendations with rationales, relationship categories, and confidence.
4. It can identify a project-level grouping without overstating task-level relatedness.
5. Users can edit the complete proposed arrangement before applying it.
6. Applying a plan changes only session/window/tab placement and optional group labels; it does not modify conversation content or session identity.
7. Existing sessions remain reachable, including sessions that are active, blocked, or resumable.
8. The feature handles large session collections with progress feedback, cancellation, and useful partial/failure behavior.
9. Analysis respects access boundaries for remote, local, or otherwise separately scoped sessions.
10. Keyboard and mouse users can complete, review, edit, apply, and cancel the flow.

## Acceptance criteria

- A user can open the organizer from the control placed immediately after **New Tab**.
- Given two sessions from the same repository but with unrelated tasks, the UI can recommend a project grouping while explicitly identifying task affinity as uncertain.
- Given sessions from different repositories with unrelated goals, the UI recommends separate groups or leaves them ungrouped.
- Given clear continuation/overlap between sessions, the UI explains the task evidence supporting a same-task recommendation.
- Every recommendation can be reviewed and changed before any layout mutation occurs.
- Canceling or failing analysis leaves all session placements unchanged.
- Applying a reviewed plan preserves each session and conversation and only changes intended placement/group labels.
- The user can recover from an accidental apply through undo or an equivalent straightforward restoration path.
- Analysis does not message, interrupt, or change the execution state of an agent session.
- The UI distinguishes unavailable/insufficient evidence from a confident recommendation.

## Success measures

- Users can identify and organize a cluttered session collection with fewer manual tab/window operations.
- A strong majority of recommendations are accepted or lightly edited rather than discarded.
- Users can understand why a recommendation was made without opening every conversation.
- No session content, execution state, or identity is lost or changed by organizing.

## Open questions

- What exact navigation surface owns the **New Tab** button, and does it model windows, workspaces, or both?
- Should the first release analyze all sessions, only recent sessions, or a user-selected subset?
- Which structured project/worktree metadata is already available to the UI without additional server/API changes?
- Should recommendations be generated locally, by the configured model, or by a hybrid approach?
- What existing undo/history mechanism can restore a prior session layout?
- Should users be able to save named groups as persistent projects, or should the first release only arrange sessions into windows?

## Suggested implementation sequence

1. Map the current session/window/tab navigation model and add the entry point with an empty/loading state.
2. Define an analysis input/output contract and collect structured metadata before adding transcript summarization.
3. Implement recommendation display, confidence/rationale, and user editing without applying changes.
4. Add a reviewed-plan application operation with validation and restoration/undo.
5. Add focused tests for affinity classification, weak evidence, insufficient context, cancellation/failure, and layout application.
6. Validate with representative cases including same-repository/different-task sessions and cross-repository unrelated sessions.

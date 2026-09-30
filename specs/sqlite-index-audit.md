# SQLite index and planner audit

Audited 2026-09-30 against application query paths and a read-only local database.
Representative local cardinalities: 3,150 sessions, 149,781 legacy messages,
718,292 parts, and 1,981,159 events. Current projected messages and prompt inbox
tables were empty locally; their query shapes were checked against their indexes.

## Changes

| Query shape                                      | Index / implementation                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Rolling usage windows, current messages          | Existing `session_message_time_created_idx`; SQL aggregation, no transcript transfers          |
| Rolling usage windows, legacy billed steps       | New partial `part_usage_time_created_idx(time_created, session_id)` for `step-finish` parts    |
| Session lists ordered by last update             | `session_updated_id_idx`, `session_project_updated_id_idx`                                     |
| Session lists ordered by creation plus ID cursor | `session_created_id_idx`, `session_project_created_id_idx`, `session_directory_created_id_idx` |
| Legacy text search within a project              | Partial `part_text_session_idx(session_id)` for text parts                                     |
| Workspace synchronization's global event order   | `event_seq_idx(seq)`                                                                           |
| Workspace lookup / reassignment by project       | `workspace_project_idx(project_id)`                                                            |

The usage endpoint returns all three hierarchy summaries in one HTTP request.
Each time range is memoized for the lifetime of the usage dialog, including
in-flight requests. Failed requests are removed from the cache. Legacy and
current usage are aggregated separately, excluding legacy parts already covered
by a current message projection and counting each session once.

SQLite can choose a full session-ordered scan to avoid the usage query's GROUP BY
sort. Usage therefore explicitly selects the timestamp indexes; plan checks
confirm timestamp range searches. The remaining temporary GROUP BY tree applies
only to the matching billing rows.

## Planner maintenance

Before this change, application initialization configured WAL, NORMAL
synchronization, a 5-second busy timeout, a 64 MB cache, foreign keys, and a
passive checkpoint, but performed neither ANALYZE nor PRAGMA optimize. The live
database had no `sqlite_stat1` or `sqlite_stat4`.

The shared application database now runs:

- `PRAGMA optimize=0x10002` after migrations, considering all tables on a new connection.
- `PRAGMA optimize` every 24 hours on long-lived connections.
- `PRAGMA optimize` on scoped disposal, before the native connection closes.

Maintenance is best-effort and logs failures. SQLite 3.46+ bounds the ANALYZE
work performed by optimize automatically; no full-database ANALYZE or permanent
analysis-limit change is added. Startup and periodic maintenance cover exits
that terminate the process without disposing the application runtime.

Installed Bun uses SQLite 3.53.2; installed Node uses 3.51.3. Neither build has
STAT4 enabled. Both can collect `sqlite_stat1`. A controlled 10,000-row experiment
and regression test show optimize changing a competing-index query from the
index matching 5,000 rows to the index matching one row.

## Already covered

- Legacy message pagination: `(session_id, time_created, id)`.
- Part loading and message deletion: `(message_id, id)`.
- Current message timeline paging: `(session_id, seq)`.
- Latest assistant / compaction: `(session_id, type, seq)`.
- Aggregate event replay: `(aggregate_id, seq)`; type filters additionally use
  `(aggregate_id, type, seq)`.
- Pending prompt admission / delivery: `(session_id, promoted_seq, delivery, admitted_seq)`.
- Session children, todos, context epochs, permissions, sharing, and identity
  lookups have appropriate existing equality/composite/primary-key indexes.

## Remaining limitations

- Literal substring search (`instr(lower(text), needle)` / leading-wildcard LIKE)
  cannot seek an ordinary B-tree. The partial text index removes non-text parts
  from the legacy search path; scalable substring search needs a maintained
  search index and final literal-match verification.
- Global workspace sync avoids its sort with `event_seq_idx`, but its negated
  aggregate exclusions still require scanning. Aggregate-scoped delta retrieval
  and bounded batches would address that larger issue.
- Optional workspace/root/archive/path/title filters can require residual
  filtering even when session ordering is indexed.
- Credential integration filtering, favorite ordering, project-directory
  ordering, and reminder snapshot ordering have low-cardinality scans/sorts.
  They are not currently high-volume bottlenecks; additional indexes should be
  driven by their future measured workloads.
- Index creation has a one-time migration cost on existing history.

## Verification

Tests: `database-index-plans.test.ts`, `database-optimize.test.ts`, and
`session-usage.test.ts` in `packages/core/test`; HTTP usage and mounted TUI tests
also cover hierarchy summaries, cutoff validation, and memoization.

An isolated in-memory copy of 3,150 real session summaries and 135,563 legacy
billing records exercised the actual usage implementation. Recorded aggregate
times were 39 ms (1d), 57 ms (1w), 231 ms (1m), and 484 ms (1y). These are
in-memory aggregate measurements, not end-to-end live-database latency promises.

Sources: `packages/core/src/database/database.ts`, `packages/core/src/session/sql.ts`,
`packages/core/src/session/usage.ts`, `packages/core/src/session.ts`,
`packages/core/src/event/sql.ts`, `packages/core/src/control-plane/workspace.sql.ts`,
`packages/opencode/src/session/session.ts`, `packages/opencode/src/tool/session-search.ts`,
and `packages/opencode/src/server/routes/instance/httpapi/handlers/sync.ts`.

SQLite guidance: <https://www.sqlite.org/lang_analyze.html#recommended_usage_patterns>.

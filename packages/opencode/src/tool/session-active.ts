import { eq, inArray, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionActivity } from "@opencode-ai/core/session/activity"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Tool } from "./tool"

export const Parameters = Schema.Struct({
  include_self: Schema.optional(Schema.Boolean).annotate({
    description: "Include the session calling this tool (default false)",
  }),
})

export const SessionActiveTool = Tool.define(
  "session_active",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const activity = yield* SessionActivity.Service
    return {
      description:
        "List sessions currently working across local OpenCode processes and projects. Shows session IDs, titles, working directories, project roots, parent sessions, busy/retry status, latest user requests, in-progress todos, and running tools. Excludes this session by default. Uses live activity heartbeats, not recent-history guesses; stopped processes expire within 30 seconds. Only sessions running a version with activity tracking are visible.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const active = (yield* activity.list()).filter(
            (item) => params.include_self || item.sessionID !== ctx.sessionID,
          )
          if (!active.length)
            return {
              title: "Active sessions",
              metadata: { sessions: 0 },
              output: params.include_self ? "No active local sessions found." : "No other active local sessions found.",
            }

          const rows = yield* database.db
            .select({
              sessionID: SessionTable.id,
              title: SessionTable.title,
              directory: SessionTable.directory,
              workspaceID: SessionTable.workspace_id,
              parentID: SessionTable.parent_id,
              project: ProjectTable.name,
              worktree: ProjectTable.worktree,
              prompt: sql<string | null>`(select substr(text, 1, 600) from (
                select json_extract(p.data, '$.text') as text, m.time_created as time
                from message m join part p on p.message_id = m.id
                where m.session_id = ${SessionTable.id} and json_extract(m.data, '$.role') = 'user'
                  and json_extract(p.data, '$.type') = 'text'
                  and coalesce(json_extract(p.data, '$.synthetic'), 0) = 0
                union all
                select json_extract(data, '$.text') as text, time_created as time
                from session_message where session_id = ${SessionTable.id} and type = 'user'
              ) order by time desc limit 1)`,
              todos: sql<string | null>`(select group_concat(content, char(10)) from
                (select substr(content, 1, 300) as content from todo
                where session_id = ${SessionTable.id} and status = 'in_progress' order by position limit 5))`,
              tools: sql<string | null>`(select group_concat(tool, ', ') from (
                select json_extract(data, '$.tool') as tool from part
                where session_id = ${SessionTable.id} and json_extract(data, '$.type') = 'tool'
                  and json_extract(data, '$.state.status') = 'running'
                union
                select json_extract(content.value, '$.name') as tool from session_message,
                  json_each(session_message.data, '$.content') as content
                where session_message.session_id = ${SessionTable.id} and session_message.type = 'assistant'
                  and json_extract(content.value, '$.type') = 'tool'
                  and json_extract(content.value, '$.state.status') = 'running'
              ))`,
            })
            .from(SessionTable)
            .innerJoin(ProjectTable, eq(SessionTable.project_id, ProjectTable.id))
            .where(
              inArray(
                SessionTable.id,
                active.map((item) => item.sessionID),
              ),
            )
            .all()
            .pipe(Effect.orDie)

          return {
            title: `Active sessions: ${rows.length}`,
            metadata: { sessions: rows.length },
            output: rows.length
              ? rows
                  .map((row) => {
                    const owners = active.filter((item) => item.sessionID === row.sessionID)
                    return [
                      `${row.title} (${row.sessionID})${row.sessionID === ctx.sessionID ? " [this session]" : ""}`,
                      ...owners.map(
                        (owner) =>
                          `Status: ${owner.status.type} · PID: ${owner.pid} · Active since: ${new Date(owner.started).toISOString()}${owner.status.type === "retry" ? ` · ${owner.status.message}` : ""}`,
                      ),
                      ...owners.map((owner) => `Directory: ${owner.directory ?? row.directory}`),
                      `Project: ${row.project ?? row.worktree} · Root: ${row.worktree}`,
                      row.workspaceID ? `Workspace: ${row.workspaceID}` : undefined,
                      row.parentID ? `Parent session: ${row.parentID}` : undefined,
                      row.prompt ? `Latest request: ${row.prompt.replace(/\s+/g, " ")}` : undefined,
                      row.todos ? `Working on:\n${row.todos}` : undefined,
                      row.tools ? `Running tools: ${row.tools}` : undefined,
                    ]
                      .filter(Boolean)
                      .join("\n")
                  })
                  .join("\n\n")
              : "No active local sessions found.",
          }
        }),
    }
  }),
)

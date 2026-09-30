import { and, desc, eq, ne, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "./tool"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "Literal keyword or phrase to find in previous sessions (case-insensitive)",
  }),
})

const limit = 30

export const SessionSearchTool = Tool.define(
  "session_search",
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return {
      description:
        "Search user and assistant text in previous sessions of the current project. Use this to recall earlier discussions (for example CI/CD). The query is a literal, case-insensitive substring, not a regex. Returns recent matches with session and message IDs; use session_switch to open a result. Refine the query if there are more results.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const query = params.query.trim()
          if (!query)
            return {
              title: "Search sessions",
              output: "Enter a keyword or phrase to search.",
              metadata: { matches: 0, more: false },
            }

          const instance = yield* InstanceState.context
          const needle = query.toLowerCase()
          const sessions = and(eq(SessionTable.project_id, instance.project.id), ne(SessionTable.id, ctx.sessionID))
          const legacy = yield* db
            .select({
              sessionID: SessionTable.id,
              title: SessionTable.title,
              messageID: MessageTable.id,
              role: sql<string>`json_extract(${MessageTable.data}, '$.role')`,
              text: sql<string>`json_extract(${PartTable.data}, '$.text')`,
              time: MessageTable.time_created,
            })
            .from(PartTable)
            .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
            .innerJoin(SessionTable, eq(PartTable.session_id, SessionTable.id))
            .where(
              and(
                sessions,
                sql`json_extract(${MessageTable.data}, '$.role') in ('user', 'assistant')`,
                sql`json_extract(${PartTable.data}, '$.type') = 'text'`,
                sql`instr(lower(json_extract(${PartTable.data}, '$.text')), ${needle}) > 0`,
              ),
            )
            .orderBy(desc(MessageTable.time_created), desc(PartTable.id))
            .limit(limit + 1)
            .all()
            .pipe(Effect.orDie)

          const current = yield* db
            .select({
              sessionID: SessionTable.id,
              title: SessionTable.title,
              messageID: SessionMessageTable.id,
              role: SessionMessageTable.type,
              text: sql<string>`case when ${SessionMessageTable.type} = 'user'
                then json_extract(${SessionMessageTable.data}, '$.text')
                else (select json_extract(content.value, '$.text')
                  from json_each(${SessionMessageTable.data}, '$.content') as content
                  where json_extract(content.value, '$.type') = 'text'
                    and instr(lower(json_extract(content.value, '$.text')), ${needle}) > 0
                  limit 1) end`,
              time: SessionMessageTable.time_created,
            })
            .from(SessionMessageTable)
            .innerJoin(SessionTable, eq(SessionMessageTable.session_id, SessionTable.id))
            .where(
              and(
                sessions,
                sql`(${SessionMessageTable.type} = 'user' and instr(lower(json_extract(${SessionMessageTable.data}, '$.text')), ${needle}) > 0)
                  or (${SessionMessageTable.type} = 'assistant' and exists (
                    select 1 from json_each(${SessionMessageTable.data}, '$.content') as content
                    where json_extract(content.value, '$.type') = 'text'
                      and instr(lower(json_extract(content.value, '$.text')), ${needle}) > 0
                  ))`,
              ),
            )
            .orderBy(desc(SessionMessageTable.time_created), desc(SessionMessageTable.id))
            .limit(limit + 1)
            .all()
            .pipe(Effect.orDie)

          const matches = [...legacy, ...current]
            .sort((a, b) => b.time - a.time || b.messageID.localeCompare(a.messageID))
            .slice(0, limit)

          const more = legacy.length + current.length > limit
          return {
            title: `Search sessions: ${query}`,
            metadata: { matches: matches.length, more },
            output: matches.length
              ? [
                  `Found ${matches.length} matches${more ? " (more available; refine the query)" : ""}:`,
                  ...matches.map((match) => {
                    const index = match.text.toLowerCase().indexOf(needle)
                    const excerpt = match.text
                      .slice(Math.max(0, index - 100), index + query.length + 160)
                      .replace(/\s+/g, " ")
                    return `\n${match.title} (${match.sessionID}) · ${match.role} · ${match.messageID}\n  ${excerpt}`
                  }),
                ].join("\n")
              : "No matches in previous sessions of this project.",
          }
        }).pipe(Effect.orDie),
    }
  }),
)

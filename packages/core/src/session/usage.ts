export * as SessionUsage from "./usage"

import { and, eq, gte, sql, type SQLWrapper } from "drizzle-orm"
import { Effect } from "effect"
import type { Session } from "@opencode-ai/schema/session"
import type { Project } from "@opencode-ai/schema/project"
import type { Database } from "../database/database"
import { PartTable, SessionMessageTable, SessionTable } from "./sql"

export type Input = { start?: number; projectID?: Project.ID; sessionID?: Session.ID }

export const read = Effect.fn("SessionUsage.read")(function* (db: Database.Interface["db"], input: Input) {
  const fields = {
    id: SessionTable.id,
    projectID: SessionTable.project_id,
    cost: SessionTable.cost,
    input: SessionTable.tokens_input,
    output: SessionTable.tokens_output,
    reasoning: SessionTable.tokens_reasoning,
    read: SessionTable.tokens_cache_read,
    write: SessionTable.tokens_cache_write,
  }
  const rows = yield* (
    input.start === undefined
      ? db.select(fields).from(SessionTable).all()
      : Effect.all([
          db
            .select({
              ...fields,
              cost: sum(SessionMessageTable.data, "$.cost"),
              input: sum(SessionMessageTable.data, "$.tokens.input"),
              output: sum(SessionMessageTable.data, "$.tokens.output"),
              reasoning: sum(SessionMessageTable.data, "$.tokens.reasoning"),
              read: sum(SessionMessageTable.data, "$.tokens.cache.read"),
              write: sum(SessionMessageTable.data, "$.tokens.cache.write"),
            })
            // Otherwise SQLite can prefer a full session-index scan to avoid sorting GROUP BY.
            .from(sql`${SessionMessageTable} indexed by session_message_time_created_idx`)
            .innerJoin(SessionTable, eq(SessionTable.id, SessionMessageTable.session_id))
            .where(and(gte(SessionMessageTable.time_created, input.start), eq(SessionMessageTable.type, "assistant")))
            .groupBy(SessionMessageTable.session_id)
            .all(),
          db
            .select({
              ...fields,
              cost: sum(PartTable.data, "$.cost"),
              input: sum(PartTable.data, "$.tokens.input"),
              output: sum(PartTable.data, "$.tokens.output"),
              reasoning: sum(PartTable.data, "$.tokens.reasoning"),
              read: sum(PartTable.data, "$.tokens.cache.read"),
              write: sum(PartTable.data, "$.tokens.cache.write"),
            })
            .from(sql`${PartTable} indexed by part_usage_time_created_idx`)
            .innerJoin(SessionTable, eq(SessionTable.id, PartTable.session_id))
            .where(
              and(
                gte(PartTable.time_created, input.start),
                sql`json_extract(${PartTable.data}, '$.type') = 'step-finish'`,
                // Transitional writes can also have a current assistant projection. Count that usage only once.
                sql`not exists (select 1 from ${SessionMessageTable}
              where ${SessionMessageTable.id} = ${PartTable.message_id}
                and ${SessionMessageTable.session_id} = ${PartTable.session_id})`,
              ),
            )
            .groupBy(PartTable.session_id)
            .all(),
        ]).pipe(Effect.map((rows) => rows.flat()))
  ).pipe(Effect.orDie)
  const empty = () => ({
    sessions: 0,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const result = { all: empty(), project: empty(), session: empty() }
  const counted = new Set<Session.ID>()
  for (const row of rows) {
    const targets = [
      result.all,
      ...(row.projectID === input.projectID ? [result.project] : []),
      ...(row.id === input.sessionID ? [result.session] : []),
    ]
    for (const target of targets) {
      if (!counted.has(row.id)) target.sessions++
      target.cost += row.cost
      target.tokens.input += row.input
      target.tokens.output += row.output
      target.tokens.reasoning += row.reasoning
      target.tokens.cache.read += row.read
      target.tokens.cache.write += row.write
    }
    counted.add(row.id)
  }
  return result
})

function sum(data: SQLWrapper, path: string) {
  return sql<number>`coalesce(sum(coalesce(json_extract(${data}, ${path}), 0)), 0)`
}

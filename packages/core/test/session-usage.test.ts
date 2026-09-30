import { expect } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/schema/project"
import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionUsage } from "@opencode-ai/core/session/usage"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))

it.effect("aggregates an indexed time window without reading transcripts or trusting session update times", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const project = Project.ID.make("project_here")
    const other = Project.ID.make("project_elsewhere")
    const session = Session.ID.make("ses_current")
    const sibling = Session.ID.make("ses_sibling")
    const elsewhere = Session.ID.make("ses_elsewhere")
    const old = Session.ID.make("ses_old")
    yield* db
      .insert(ProjectTable)
      .values([
        { id: project, worktree: AbsolutePath.make("/here"), sandboxes: [] },
        { id: other, worktree: AbsolutePath.make("/elsewhere"), sandboxes: [] },
      ])
      .run()
    yield* db
      .insert(SessionTable)
      .values(
        [session, sibling, elsewhere, old].map((id) => ({
          id,
          project_id: id === elsewhere ? other : project,
          slug: id,
          directory: "/here",
          title: id,
          version: "test",
          time_created: 1,
          time_updated: 1,
          cost: 20,
          tokens_input: 10,
        })),
      )
      .run()
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: SessionMessage.ID.make("msg_old"),
          session_id: session,
          seq: 1,
          type: "assistant" as const,
          time_created: 99,
          data: data(99, 100),
        },
        {
          id: SessionMessage.ID.make("msg_boundary"),
          session_id: session,
          seq: 2,
          type: "assistant" as const,
          time_created: 100,
          data: data(100, 1.5, { input: 10, output: 5, reasoning: 2, cache: { read: 4, write: 1 } }),
        },
        {
          id: SessionMessage.ID.make("msg_missing"),
          session_id: session,
          seq: 3,
          type: "assistant" as const,
          time_created: 101,
          data: data(101),
        },
        {
          id: SessionMessage.ID.make("msg_sibling"),
          session_id: sibling,
          seq: 1,
          type: "assistant" as const,
          time_created: 101,
          data: data(101, 2),
        },
        {
          id: SessionMessage.ID.make("msg_elsewhere"),
          session_id: elsewhere,
          seq: 1,
          type: "assistant" as const,
          time_created: 101,
          data: data(101, 3),
        },
        {
          id: SessionMessage.ID.make("msg_old_session"),
          session_id: old,
          seq: 1,
          type: "assistant" as const,
          time_created: 99,
          data: data(99, 100),
        },
      ])
      .run()
    const result = yield* SessionUsage.read(db, { start: 100, projectID: project, sessionID: session })
    expect(result.all.sessions).toBe(3)
    expect(result.all.cost).toBe(6.5)
    expect(result.project.sessions).toBe(2)
    expect(result.project.cost).toBe(3.5)
    expect(result.session).toEqual({
      sessions: 1,
      cost: 1.5,
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 4, write: 1 } },
    })
    const lifetime = yield* SessionUsage.read(db, { projectID: project, sessionID: session })
    expect(lifetime.all.sessions).toBe(4)
    expect(lifetime.all.cost).toBe(80)
    expect(lifetime.project.cost).toBe(60)
    expect(lifetime.session.tokens.input).toBe(10)
    const empty = yield* SessionUsage.read(db, { start: 102 })
    expect(empty.all).toEqual({
      sessions: 0,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const plan = yield* db.all<{ detail: string }>(sql`explain query plan
      select session.id, sum(json_extract(session_message.data, '$.cost'))
      from session_message indexed by session_message_time_created_idx
      join session on session.id = session_message.session_id
      where session_message.time_created >= 100 group by session_message.session_id`)
    expect(plan.some((row) => row.detail.includes("session_message_time_created_idx"))).toBe(true)
    yield* db.run(sql`insert into message(id, session_id, time_created, time_updated, data) values
      ('msg_legacy', ${session}, 101, 101, '{}'),
      ('msg_boundary', ${session}, 100, 100, '{}'),
      ('msg_legacy_only', ${old}, 101, 101, '{}')`)
    yield* db.run(sql`insert into part(id, message_id, session_id, time_created, time_updated, data) values
      ('prt_legacy', 'msg_legacy', ${session}, 101, 101, '{"type":"step-finish","cost":2,"tokens":{"input":5}}'),
      ('prt_duplicate', 'msg_boundary', ${session}, 100, 100, '{"type":"step-finish","cost":88}'),
      ('prt_legacy_only', 'msg_legacy_only', ${old}, 101, 101, '{"type":"step-finish","cost":4}'),
      ('prt_old', 'msg_legacy', ${session}, 99, 99, '{"type":"step-finish","cost":100}'),
      ('prt_text', 'msg_legacy', ${session}, 101, 101, '{"type":"text","cost":100}')`)
    const mixed = yield* SessionUsage.read(db, { start: 100, projectID: project, sessionID: session })
    expect(mixed.all.sessions).toBe(4)
    expect(mixed.all.cost).toBe(12.5)
    expect(mixed.project.sessions).toBe(3)
    expect(mixed.project.cost).toBe(9.5)
    expect(mixed.session.cost).toBe(3.5)
    expect(mixed.session.tokens.input).toBe(15)
    const legacyPlan = yield* db.all<{ detail: string }>(sql`explain query plan
      select session.id, sum(json_extract(part.data, '$.cost'))
      from part indexed by part_usage_time_created_idx
      join session on session.id = part.session_id
      where part.time_created >= 100 and json_extract(part.data, '$.type') = 'step-finish'
      group by part.session_id`)
    expect(legacyPlan.some((row) => row.detail.includes("part_usage_time_created_idx"))).toBe(true)
  }),
)

function data(created: number, cost?: number, tokens?: Session.UsageSummary["tokens"]) {
  return { time: { created }, cost, tokens }
}

import { expect } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))

it.effect("session lists and global event ordering use ordered indexes without temporary sorts", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    for (const item of [
      { query: "select * from session order by time_updated desc limit 100", index: "session_updated_id_idx" },
      {
        query: "select * from session where project_id = 'here' order by time_updated desc limit 100",
        index: "session_project_updated_id_idx",
      },
      { query: "select * from session order by time_created desc, id desc limit 50", index: "session_created_id_idx" },
      {
        query: "select * from session where project_id = 'here' order by time_created desc, id desc limit 50",
        index: "session_project_created_id_idx",
      },
      {
        query: "select * from session where directory = '/here' order by time_created desc, id desc limit 50",
        index: "session_directory_created_id_idx",
      },
      { query: "select * from event order by seq", index: "event_seq_idx" },
      { query: "select * from workspace where project_id = 'here'", index: "workspace_project_idx" },
      {
        query: "select * from part where session_id = 'here' and json_extract(data, '$.type') = 'text'",
        index: "part_text_session_idx",
      },
    ]) {
      const plan = yield* database.db.all<{ detail: string }>(sql.raw(`explain query plan ${item.query}`))
      expect(plan.some((row) => row.detail.includes(item.index))).toBe(true)
      expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false)
    }
  }),
)

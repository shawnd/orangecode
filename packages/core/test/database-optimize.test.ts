import { expect } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))

it.effect("bounded planner maintenance collects statistics and improves selective query plans", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    yield* db.run(sql`create table planner_probe(a integer, b integer)`)
    yield* db.run(sql`create index planner_probe_b on planner_probe(b)`)
    yield* db.run(sql`create index planner_probe_a on planner_probe(a)`)
    yield* db.run(sql`with recursive numbers(x) as (
      select 1 union all select x + 1 from numbers where x < 10000
    ) insert into planner_probe select x % 2, x from numbers`)
    const before = yield* db.all<{ detail: string }>(sql`explain query plan
      select * from planner_probe where a = 1 and b = 9999`)
    expect(before.some((row) => row.detail.includes("planner_probe_a"))).toBe(true)
    yield* Database.optimize(db, true)
    const statistics = yield* db.all<{ idx: string }>(sql`select idx from sqlite_stat1 where tbl = 'planner_probe'`)
    expect(statistics.map((row) => row.idx).sort()).toEqual(["planner_probe_a", "planner_probe_b"])
    const after = yield* db.all<{ detail: string }>(sql`explain query plan
      select * from planner_probe where a = 1 and b = 9999`)
    expect(after.some((row) => row.detail.includes("planner_probe_b"))).toBe(true)
    yield* Database.optimize(db)
    expect(yield* db.all(sql`select * from planner_probe where a = 1 and b = 9999`)).toEqual([{ a: 1, b: 9999 }])
    expect(yield* db.get(sql`pragma analysis_limit`)).toEqual({ analysis_limit: 0 })
  }),
)

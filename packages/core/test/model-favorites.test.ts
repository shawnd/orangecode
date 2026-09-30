import path from "path"
import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../src/database/database"
import { DataMigrationTable } from "../src/data-migration.sql"
import { LayerNode } from "../src/effect/layer-node"
import { FSUtil } from "../src/fs-util"
import { ModelFavorites } from "../src/model-favorites"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, FSUtil.node])))
const first = { providerID: "openai", modelID: "gpt-6.1-sol" }
const second = { providerID: "openrouter", modelID: "openai/gpt-6.1-sol" }
const directory = Effect.acquireRelease(Effect.promise(tmpdir), (dir) =>
  Effect.promise(() => dir[Symbol.asyncDispose]()),
).pipe(Effect.map((dir) => dir.path))

it.live("migrates protected JSON favorites once, preserving order and deduplicating rows", () =>
  Effect.gen(function* () {
    const dir = yield* directory
    const fs = yield* FSUtil.Service
    yield* fs.writeJson(path.join(dir, "model-favorites.json"), { favorite: [second, first, first] })
    yield* fs.writeJson(path.join(dir, "model.json"), { favorite: [] })
    const favorites = yield* ModelFavorites.Service.pipe(Effect.provide(ModelFavorites.layer(dir)))
    expect(yield* favorites.list()).toEqual([second, first])
    yield* favorites.set(first, false)
    // Rebuilding the service must not reimport the old JSON or resurrect removals.
    const reopened = yield* ModelFavorites.Service.pipe(Effect.provide(ModelFavorites.layer(dir)))
    expect(yield* reopened.list()).toEqual([second])
  }),
)

it.live("migrates legacy model.json favorites when protected JSON does not exist", () =>
  Effect.gen(function* () {
    const dir = yield* directory
    const fs = yield* FSUtil.Service
    yield* fs.writeJson(path.join(dir, "model.json"), { favorite: [first] })
    const favorites = yield* ModelFavorites.Service.pipe(Effect.provide(ModelFavorites.layer(dir)))
    expect(yield* favorites.list()).toEqual([first])
  }),
)

it.live("an empty protected favorites list is authoritative over legacy JSON", () =>
  Effect.gen(function* () {
    const dir = yield* directory
    const fs = yield* FSUtil.Service
    yield* fs.writeJson(path.join(dir, "model.json"), { favorite: [first] })
    yield* fs.writeJson(path.join(dir, "model-favorites.json"), { favorite: [] })
    const favorites = yield* ModelFavorites.Service.pipe(Effect.provide(ModelFavorites.layer(dir)))
    expect(yield* favorites.list()).toEqual([])
  }),
)

it.live("favorites are global across service instances and migration directories", () =>
  Effect.gen(function* () {
    const a = yield* directory
    const b = yield* directory
    const fs = yield* FSUtil.Service
    yield* fs.writeJson(path.join(b, "model.json"), { favorite: [second] })
    const one = yield* ModelFavorites.Service.pipe(Effect.provide(ModelFavorites.layer(a)))
    const two = yield* ModelFavorites.Service.pipe(Effect.provide(ModelFavorites.layer(b)))
    expect(yield* two.list()).toEqual([])
    yield* Effect.all([one.set(first, true), two.set(second, true), two.set(first, true)], { concurrency: "unbounded" })
    expect(yield* one.list()).toHaveLength(2)
    expect(yield* two.list()).toEqual(yield* one.list())
    yield* two.set(second, false)
    expect(yield* one.list()).toEqual([first])
  }),
)

it.live("a failed JSON import does not mark migration complete and can be retried", () =>
  Effect.gen(function* () {
    const dir = yield* directory
    const fs = yield* FSUtil.Service
    const database = yield* Database.Service
    yield* fs.writeFileString(path.join(dir, "model-favorites.json"), "{")
    const failed = yield* ModelFavorites.Service.pipe(Effect.provide(ModelFavorites.layer(dir)), Effect.exit)
    expect(Exit.isFailure(failed)).toBe(true)
    expect(
      yield* database.db
        .select()
        .from(DataMigrationTable)
        .where(eq(DataMigrationTable.name, "global-model-favorites-json"))
        .get(),
    ).toBeUndefined()
    yield* fs.writeJson(path.join(dir, "model-favorites.json"), { favorite: [first] })
    const favorites = yield* ModelFavorites.Service.pipe(Effect.provide(ModelFavorites.layer(dir)))
    expect(yield* favorites.list()).toEqual([first])
  }),
)

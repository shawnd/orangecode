import path from "path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { ModelFavorites } from "@opencode-ai/core/model-favorites"
import { Models } from "../../src/tool/models"
import { ModelsFormat } from "../../src/tool/models-format"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, CrossSpawnSpawner.node, Database.node])))
const favorite = { providerID: "openai", modelID: "gpt-6.1-sol" }

it.live("model tools read protected favorites even after an old binary overwrites model.json", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    yield* fs.writeJson(path.join(dir, "model-favorites.json"), { favorite: [favorite] })
    yield* fs.writeJson(path.join(dir, "model.json"), {
      favorite: [],
      recent: [favorite],
      variant: { "openai/gpt-6.1-sol": "high" },
    })
    const favorites = yield* ModelFavorites.Service.pipe(Effect.provide(ModelFavorites.layer(dir)))
    const saved = yield* Models.readSaved(fs, dir, favorites)
    expect(saved.favorite).toEqual([favorite])
    expect(saved.variant["openai/gpt-6.1-sol"]).toBe("high")
    const models = [
      { ...favorite, name: "GPT 6.1 Sol", variants: ["high"] },
      { ...favorite, providerID: "opencode", name: "GPT 6.1 Sol", variants: ["high"] },
    ]
    expect(ModelsFormat.formatList({ saved, models })).toContain("Favorites:")
    expect(ModelsFormat.formatSearch({ query: "sol", saved, models }).split("\n")[0]).toContain("openai/gpt-6.1-sol")
  }),
)

it.live("an empty protected favorites file overrides stale legacy favorites", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    yield* fs.writeJson(path.join(dir, "model.json"), { favorite: [favorite] })
    yield* fs.writeJson(path.join(dir, "model-favorites.json"), { favorite: [] })
    const favorites = yield* ModelFavorites.Service.pipe(Effect.provide(ModelFavorites.layer(dir)))
    expect((yield* Models.readSaved(fs, dir, favorites)).favorite).toEqual([])
  }),
)

it.live("model tools migrate legacy favorites and reload SQLite changes instead of stale JSON", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    yield* fs.writeJson(path.join(dir, "model.json"), { favorite: [favorite] })
    const favorites = yield* ModelFavorites.Service.pipe(Effect.provide(ModelFavorites.layer(dir)))
    expect((yield* Models.readSaved(fs, dir, favorites)).favorite).toEqual([favorite])
    yield* favorites.set(favorite, false)
    expect((yield* Models.readSaved(fs, dir, favorites)).favorite).toEqual([])
    yield* favorites.set(favorite, true)
    expect((yield* Models.readSaved(fs, dir, favorites)).favorite).toEqual([favorite])
  }),
)

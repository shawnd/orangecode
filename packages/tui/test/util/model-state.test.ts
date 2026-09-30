import { expect, test } from "bun:test"
import path from "path"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { ModelFavorites } from "@opencode-ai/core/model-favorites"
import { createModelState, type ModelState } from "../../src/util/model-state"
import { readJson, writeJsonAtomic } from "../../src/util/persistence"

const first = { providerID: "openai", modelID: "sol" }
const second = { providerID: "opencode", modelID: "astra" }

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-model-state-"))
  const instances: ReturnType<typeof createModelState>[] = []
  const errors: unknown[] = []
  const database = path.join(dir, "opencode.db")
  const state = path.join(dir, "nested")
  const favorites = ModelFavorites.store({ database, state })
  return {
    file: path.join(state, "model.json"),
    database,
    favorites,
    errors,
    open(onChange: (value: ModelState) => void = () => {}) {
      const instance = createModelState({
        file: this.file,
        favorites: ModelFavorites.store({ database, state }),
        onChange,
        onError: (error) => errors.push(error),
      })
      instances.push(instance)
      return instance
    },
    async [Symbol.asyncDispose]() {
      await Promise.all(instances.map((instance) => instance.dispose()))
      await favorites.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test("an older instance observes SQLite favorites added and removed by another instance without focus", async () => {
  await using setup = await fixture()
  const added = Promise.withResolvers<ModelState>()
  const removed = Promise.withResolvers<ModelState>()
  const seen: ModelState[] = []
  const older = setup.open((value) => {
    seen.push(value)
    if (value.favorite.length === 1) added.resolve(value)
    if (seen.some((state) => state.favorite.length === 1) && value.favorite.length === 0) removed.resolve(value)
  })
  await older.ready
  const newer = setup.open()
  await newer.ready
  await newer.setFavorite(first, true)
  expect((await added.promise).favorite).toEqual([first])
  await newer.setFavorite(first, false)
  expect((await removed.promise).favorite).toEqual([])
  expect(setup.errors).toEqual([])
})

test("recent and variant writes preserve SQLite favorites and do not write favorites to JSON", async () => {
  await using setup = await fixture()
  const older = setup.open()
  const newer = setup.open()
  await Promise.all([older.ready, newer.ready])
  await newer.setFavorite(first, true)
  await older.update((value) => ({ ...value, recent: [second] }))
  await older.update((value) => ({ ...value, variant: { ...value.variant, "opencode/astra": "high" } }))
  expect(await readJson<unknown>(setup.file)).toEqual({ recent: [second], variant: { "opencode/astra": "high" } })
  expect(await setup.favorites.list()).toEqual([first])
})

test("concurrent favorite updates do not lose rows and removals preserve other favorites", async () => {
  await using setup = await fixture()
  const a = setup.open()
  const b = setup.open()
  await Promise.all([a.ready, b.ready])
  await Promise.all([a.setFavorite(first, true), b.setFavorite(second, true), b.setFavorite(first, true)])
  expect(await setup.favorites.list()).toHaveLength(2)
  await a.setFavorite(first, false)
  expect(await setup.favorites.list()).toEqual([second])
})

test("updates before initial loading are optimistic and persist in order without undoing migration", async () => {
  await using setup = await fixture()
  await writeJsonAtomic(setup.file, { favorite: [second], recent: [], variant: {} })
  const seen: ModelState[] = []
  const state = setup.open((value) => seen.push(value))
  const add = state.setFavorite(first, true)
  expect(seen.at(-1)?.favorite).toEqual([first])
  const remove = state.setFavorite(first, false)
  expect(seen.at(-1)?.favorite).toEqual([])
  await Promise.all([state.ready, add, remove])
  expect(await setup.favorites.list()).toEqual([second])
  expect(seen.at(-1)?.favorite).toEqual([second])
})

test("separate processes concurrently persist favorites in the same SQLite database", async () => {
  await using setup = await fixture()
  await setup.favorites.list()
  const code = (model: typeof first) => `
    import { ModelFavorites } from ${JSON.stringify(path.resolve(import.meta.dir, "../../../core/src/model-favorites.ts"))}
    const store = ModelFavorites.store({ database: ${JSON.stringify(setup.database)}, state: ${JSON.stringify(path.dirname(setup.file))} })
    await store.set(${JSON.stringify(model)}, true)
    await store.dispose()
  `
  const processes = [first, second].map((model) =>
    Bun.spawn([process.execPath, "--eval", code(model)], { stdout: "ignore", stderr: "pipe" }),
  )
  await Promise.all(
    processes.map(async (child) => {
      const error = await new Response(child.stderr).text()
      expect(await child.exited, error).toBe(0)
    }),
  )
  expect(await setup.favorites.list()).toContainEqual(first)
  expect(await setup.favorites.list()).toContainEqual(second)
})

test("failed JSON updates do not corrupt state or block later updates or SQLite favorites", async () => {
  await using setup = await fixture()
  const state = setup.open()
  await state.ready
  await state.setFavorite(second, true)
  await Bun.write(setup.file, "{")
  await expect(state.update((value) => ({ ...value, recent: [first] }))).rejects.toThrow()
  expect(await Bun.file(setup.file).text()).toBe("{")
  await writeJsonAtomic(setup.file, { favorite: [first], recent: [], variant: {} })
  await state.update((value) => ({ ...value, recent: [first] }))
  expect(await readJson<unknown>(setup.file)).toEqual({ recent: [first], variant: {} })
  expect(await setup.favorites.list()).toEqual([second])
})

test("favorites survive legacy JSON overwrites and a new instance", async () => {
  await using setup = await fixture()
  const seen: ModelState[] = []
  const state = setup.open((value) => seen.push(value))
  await state.ready
  await state.setFavorite(first, true)
  await writeJsonAtomic(setup.file, { favorite: [], recent: [second], variant: {} })
  await state.refresh()
  expect(seen.at(-1)?.favorite).toEqual([first])
  expect(seen.at(-1)?.recent).toEqual([second])
  const reopened: ModelState[] = []
  const newer = setup.open((value) => reopened.push(value))
  await newer.ready
  expect(reopened.at(-1)?.favorite).toEqual([first])
})

test("intentional unfavorites survive stale JSON writes and a restart without reimporting", async () => {
  await using setup = await fixture()
  await writeJsonAtomic(setup.file, { favorite: [first], recent: [], variant: {} })
  const state = setup.open()
  await state.ready
  await state.setFavorite(first, false)
  await writeJsonAtomic(setup.file, { favorite: [first], recent: [second], variant: {} })
  const seen: ModelState[] = []
  const restarted = setup.open((value) => seen.push(value))
  await restarted.ready
  expect(seen.at(-1)?.favorite).toEqual([])
})

test("closing immediately after favoriting flushes admitted writes before releasing SQLite", async () => {
  await using setup = await fixture()
  const state = setup.open()
  const writes = [state.setFavorite(first, true), state.setFavorite(second, true), state.setFavorite(first, false)]
  await state.dispose()
  expect(await setup.favorites.list()).toEqual([second])
  await Promise.all(writes)
  await expect(state.setFavorite(first, true)).rejects.toThrow("closed")
})

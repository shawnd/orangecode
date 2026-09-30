import path from "path"
import { watch, type FSWatcher } from "fs"
import { mkdir } from "fs/promises"
import { Flock } from "@opencode-ai/core/util/flock"
import type { ModelFavorites } from "@opencode-ai/core/model-favorites"
import { readJson, writeJsonAtomic } from "./persistence"

export type SavedModel = ModelFavorites.Model

export interface ModelState {
  recent: SavedModel[]
  favorite: SavedModel[]
  variant: Record<string, string | undefined>
}

export function createModelState(input: {
  file: string
  favorites: ModelFavorites.Store
  onChange: (state: ModelState) => void
  onError: (error: unknown) => void
}) {
  let saved: ModelState = { recent: [], favorite: [], variant: {} }
  const pending: ((state: ModelState) => ModelState)[] = []
  let queue = Promise.resolve()
  let watcher: FSWatcher | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let checking = false
  let closed = false
  let closing: Promise<void> | undefined

  function publish() {
    if (closed) return
    input.onChange(pending.reduce((state, change) => change(state), saved))
  }

  function enqueue(run: () => Promise<void>) {
    const next = queue.then(run)
    queue = next.catch(() => {})
    return next
  }

  function refresh() {
    if (closed) return closing ?? queue
    return enqueue(async () => {
      saved = await readModelState(input.file, input.favorites)
      publish()
    })
  }

  function commit(change: (state: ModelState) => ModelState, persist: () => Promise<ModelState>) {
    if (closed) return Promise.reject(new Error("Model preferences are closed"))
    pending.push(change)
    publish()
    return enqueue(async () => {
      const result = await persist().then(
        (state) => ({ state }),
        (error: unknown) => ({ error }),
      )
      pending.shift()
      if ("state" in result) saved = result.state
      publish()
      if ("error" in result) throw result.error
    })
  }

  const ready = enqueue(async () => {
    await mkdir(path.dirname(input.file), { recursive: true })
    if (closed) return
    // Atomic JSON saves replace the inode, so watch the containing directory.
    watcher = watch(path.dirname(input.file), { persistent: false }, (_, filename) => {
      if (closed) return
      if (filename !== null && filename.toString() !== path.basename(input.file)) return
      void refresh().catch(input.onError)
    })
    watcher.on("error", input.onError)
    saved = await readModelState(input.file, input.favorites)
    publish()
    if (closed) return
    // Poll only favorites, rather than reacting to every session write to the
    // shared SQLite WAL. Focus refreshes also pick up external changes.
    timer = setInterval(() => {
      if (checking || closed) return
      checking = true
      void enqueue(async () => {
        const favorite = await input.favorites.list()
        if (JSON.stringify(favorite) === JSON.stringify(saved.favorite)) return
        saved = { ...saved, favorite }
        publish()
      })
        .catch(input.onError)
        .finally(() => {
          checking = false
        })
    }, 1000)
    timer.unref()
  })

  return {
    ready,
    refresh,
    update(change: (state: ModelState) => ModelState) {
      return commit(change, () =>
        Flock.withLock(
          `tui-model:${path.resolve(input.file)}`,
          async () => {
            const current = await readModelState(input.file, input.favorites)
            const next = change(current)
            await writeJsonAtomic(input.file, { recent: next.recent, variant: next.variant })
            return { ...next, favorite: await input.favorites.list() }
          },
          { dir: path.join(path.dirname(input.file), "locks") },
        ),
      )
    },
    setFavorite(model: SavedModel, favorite: boolean) {
      return commit(
        (value) => ({
          ...value,
          favorite: [
            ...(favorite ? [{ providerID: model.providerID, modelID: model.modelID }] : []),
            ...value.favorite.filter((item) => item.providerID !== model.providerID || item.modelID !== model.modelID),
          ],
        }),
        async () => {
          await input.favorites.set(model, favorite)
          return { ...saved, favorite: await input.favorites.list() }
        },
      )
    },
    dispose() {
      if (closing) return closing
      closed = true
      watcher?.close()
      if (timer) clearInterval(timer)
      // Finish admitted writes before releasing the SQLite runtime or exiting.
      return (closing = queue.finally(() => input.favorites.dispose()))
    },
  }
}

async function readModelState(file: string, favorites: ModelFavorites.Store): Promise<ModelState> {
  const value = await readJson<unknown>(file).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  const data = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
  return {
    recent: models(data.recent),
    favorite: await favorites.list(),
    variant:
      typeof data.variant === "object" && data.variant !== null
        ? Object.fromEntries(Object.entries(data.variant).filter(([, value]) => typeof value === "string"))
        : {},
  }
}

function models(value: unknown): SavedModel[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item: unknown): item is SavedModel =>
      typeof item === "object" &&
      item !== null &&
      "providerID" in item &&
      "modelID" in item &&
      typeof item.providerID === "string" &&
      typeof item.modelID === "string",
  )
}

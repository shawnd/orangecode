import path from "path"
import { onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { missing, readText, writeTextAtomic } from "../util/persistence"
import { createPersistentState } from "../util/persistent-state"
import { useShutdown } from "../context/shutdown"

type FrecencyEntry = { path: string; frequency: number; lastOpen: number }

export const MAX_FRECENCY_ENTRIES = 1000

export function parseFrecency(text: string) {
  const latest = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as FrecencyEntry
      } catch {
        return undefined
      }
    })
    .filter((line): line is FrecencyEntry => line !== undefined)
    .reduce<Record<string, FrecencyEntry>>((result, entry) => {
      result[entry.path] = entry
      return result
    }, {})
  return Object.values(latest)
    .sort((a, b) => b.lastOpen - a.lastOpen)
    .slice(0, MAX_FRECENCY_ENTRIES)
}

function calculateFrecency(entry?: { frequency: number; lastOpen: number }) {
  if (!entry) return 0
  return entry.frequency / (1 + (Date.now() - entry.lastOpen) / 86400000)
}

export const { use: useFrecency, provider: FrecencyProvider } = createSimpleContext({
  name: "Frecency",
  init: () => {
    const paths = useTuiPaths()
    const frecencyPath = path.join(paths.state, "frecency.jsonl")
    const shutdown = useShutdown()
    const [store, setStore] = createStore({ data: {} as Record<string, { frequency: number; lastOpen: number }> })
    const state = createPersistentState({
      file: frecencyPath,
      initial: {} as Record<string, { frequency: number; lastOpen: number }>,
      read: async () =>
        Object.fromEntries(
          parseFrecency(
            await readText(frecencyPath).catch((error: unknown) => {
              if (missing(error)) return ""
              throw error
            }),
          ).map((entry) => [entry.path, { frequency: entry.frequency, lastOpen: entry.lastOpen }]),
        ),
      write: (value) =>
        writeTextAtomic(
          frecencyPath,
          Object.entries(value)
            .map(([path, entry]) => JSON.stringify({ path, ...entry }))
            .join("\n") + (Object.keys(value).length ? "\n" : ""),
        ),
      onChange: (value) => setStore("data", reconcile(value)),
      onError: (error) => console.error("Failed to persist file usage", { error }),
    })
    onCleanup(() => shutdown(state.dispose()))

    function updateFrecency(filePath: string) {
      const absolutePath = path.resolve(paths.cwd, filePath)
      const now = Date.now()
      void state
        .update((value) =>
          Object.fromEntries(
            Object.entries({
              ...value,
              [absolutePath]: {
                frequency: (value[absolutePath]?.frequency ?? 0) + 1,
                lastOpen: Math.max(value[absolutePath]?.lastOpen ?? 0, now),
              },
            })
              .sort(([, a], [, b]) => b.lastOpen - a.lastOpen)
              .slice(0, MAX_FRECENCY_ENTRIES),
          ),
        )
        .catch(() => {})
    }

    return {
      getFrecency: (filePath: string) => calculateFrecency(store.data[path.resolve(paths.cwd, filePath)]),
      updateFrecency,
      data: () => store.data,
    }
  },
})

import path from "path"
import { onCleanup } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { missing, readText, writeTextAtomic } from "../util/persistence"
import { createPersistentState } from "../util/persistent-state"
import { useShutdown } from "../context/shutdown"
import type { PromptInfo } from "./history"

export type StashEntry = {
  input: string
  parts: PromptInfo["parts"]
  timestamp: number
}

export const MAX_STASH_ENTRIES = 50

export function parsePromptStash(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as StashEntry
      } catch {
        return undefined
      }
    })
    .filter((line): line is StashEntry => line !== undefined)
    .slice(-MAX_STASH_ENTRIES)
}

export const { use: usePromptStash, provider: PromptStashProvider } = createSimpleContext({
  name: "PromptStash",
  init: () => {
    const paths = useTuiPaths()
    const stashPath = path.join(paths.state, "prompt-stash.jsonl")
    const shutdown = useShutdown()
    const [store, setStore] = createStore({ entries: [] as StashEntry[] })
    const state = createPersistentState({
      file: stashPath,
      initial: [] as StashEntry[],
      read: async () =>
        parsePromptStash(
          await readText(stashPath).catch((error: unknown) => {
            if (missing(error)) return ""
            throw error
          }),
        ),
      write: (value) =>
        writeTextAtomic(stashPath, value.map((line) => JSON.stringify(line)).join("\n") + (value.length ? "\n" : "")),
      onChange: (value) => setStore("entries", value),
      onError: (error) => console.error("Failed to persist prompt stash", { error }),
    })
    onCleanup(() => shutdown(state.dispose()))

    return {
      list() {
        return store.entries
      },
      push(entry: Omit<StashEntry, "timestamp">) {
        const stash = structuredClone(unwrap({ ...entry, timestamp: Date.now() }))
        void state.update((value) => [...value, stash].slice(-MAX_STASH_ENTRIES)).catch(() => {})
      },
      pop() {
        if (store.entries.length === 0) return undefined
        const entry = store.entries[store.entries.length - 1]
        const selected = structuredClone(unwrap(entry))
        void state.update((value) => removeEntry(value, selected)).catch(() => {})
        return entry
      },
      remove(index: number) {
        if (index < 0 || index >= store.entries.length) return
        const selected = structuredClone(unwrap(store.entries[index]))
        void state.update((value) => removeEntry(value, selected)).catch(() => {})
      },
    }
  },
})

function removeEntry(value: StashEntry[], selected: StashEntry) {
  const index = value.findLastIndex((entry) => JSON.stringify(entry) === JSON.stringify(selected))
  return value.filter((_, at) => at !== index)
}

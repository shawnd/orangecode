import path from "path"
import { onCleanup } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import type { AgentPart, FilePart, TextPart } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { missing, readText, writeTextAtomic } from "../util/persistence"
import { createPersistentState } from "../util/persistent-state"
import { useShutdown } from "../context/shutdown"

export type PromptInfo = {
  input: string
  mode?: "normal" | "shell"
  parts: (
    | Omit<FilePart, "id" | "messageID" | "sessionID">
    | Omit<AgentPart, "id" | "messageID" | "sessionID">
    | (Omit<TextPart, "id" | "messageID" | "sessionID"> & {
        source?: {
          text: {
            start: number
            end: number
            value: string
          }
        }
      })
  )[]
}

export const MAX_HISTORY_ENTRIES = 50

export function parsePromptHistory(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as PromptInfo
      } catch {
        return undefined
      }
    })
    .filter((line): line is PromptInfo => line !== undefined)
    .slice(-MAX_HISTORY_ENTRIES)
}

export function isDuplicateEntry(previous: PromptInfo | undefined, next: PromptInfo): boolean {
  if (!previous) return false
  return JSON.stringify(previous) === JSON.stringify(next)
}

export const { use: usePromptHistory, provider: PromptHistoryProvider } = createSimpleContext({
  name: "PromptHistory",
  init: () => {
    const paths = useTuiPaths()
    const historyPath = path.join(paths.state, "prompt-history.jsonl")
    const shutdown = useShutdown()
    const [store, setStore] = createStore({
      index: 0,
      history: [] as PromptInfo[],
    })
    const state = createPersistentState({
      file: historyPath,
      initial: [] as PromptInfo[],
      read: async () =>
        parsePromptHistory(
          await readText(historyPath).catch((error: unknown) => {
            if (missing(error)) return ""
            throw error
          }),
        ),
      write: (value) =>
        writeTextAtomic(historyPath, value.map((line) => JSON.stringify(line)).join("\n") + (value.length ? "\n" : "")),
      onChange: (value) => setStore("history", value),
      onError: (error) => console.error("Failed to persist prompt history", { error }),
    })
    onCleanup(() => shutdown(state.dispose()))

    return {
      isBrowsing(input: string) {
        return store.index < 0 && store.history.at(store.index)?.input === input
      },
      move(direction: 1 | -1, input: string) {
        if (!store.history.length) return undefined
        const current = store.history.at(store.index)
        if (!current) return undefined
        if (current.input !== input && input.length) return
        setStore(
          produce((draft) => {
            const next = store.index + direction
            if (Math.abs(next) > store.history.length) return
            if (next > 0) return
            draft.index = next
          }),
        )
        if (store.index === 0) return { input: "", parts: [] }
        return store.history.at(store.index)
      },
      append(item: PromptInfo) {
        const entry = structuredClone(unwrap(item))
        if (isDuplicateEntry(store.history.at(-1), entry)) {
          setStore("index", 0)
          return
        }
        setStore("index", 0)
        void state
          .update((value) =>
            isDuplicateEntry(value.at(-1), entry) ? value : [...value, entry].slice(-MAX_HISTORY_ENTRIES),
          )
          .catch(() => {})
      },
    }
  },
})

import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSignal, onCleanup } from "solid-js"
import type { NativeReminders } from "@opencode-ai/core/native/reminders"
import { createSimpleContext } from "./helper"
import { useTuiPaths } from "./runtime"
import { errorMessage } from "../util/error"

export const {
  use: useReminders,
  provider: RemindersProvider,
  context: RemindersContext,
} = createSimpleContext({
  name: "Reminders",
  init: () => {
    const paths = useTuiPaths()
    const [snapshot, setSnapshot] = createSignal<NativeReminders.Snapshot>({ reminders: [], now: Date.now() })
    const [error, setError] = createSignal<string>()
    let disposed = false
    let store: ReturnType<typeof NativeReminders.open> | undefined
    const loaded = Promise.all([mkdir(paths.state, { recursive: true }), import("@opencode-ai/core/native/reminders")])
      .then(([, { NativeReminders }]) => {
        if (disposed) return
        store = NativeReminders.open(path.join(paths.state, "reminders.sqlite3"))
        refresh()
        return store
      })
      .catch((cause) => {
        if (!disposed) setError(errorMessage(cause))
      })

    function refresh() {
      if (!store || disposed) return
      const next = store.poll()
      if (next) setSnapshot(next)
      setError(undefined)
    }

    // Rust checks SQLite's connection revision and the next due timestamp. Idle
    // ticks return null, avoiding row scans, JSON snapshots, and reactive churn.
    const timer = setInterval(() => {
      if (!store || disposed) return
      try {
        refresh()
      } catch (cause) {
        setError(errorMessage(cause))
      }
    }, 1000)
    onCleanup(() => {
      disposed = true
      clearInterval(timer)
      store?.close()
    })

    async function run<T>(operation: (store: ReturnType<typeof NativeReminders.open>) => T) {
      const native = await loaded
      if (!native || disposed) throw new Error(error() ?? "Reminder store is unavailable")
      const result = operation(native)
      refresh()
      return result
    }

    return {
      snapshot,
      error,
      parse: (text: string) => run((store) => store.parse(text)),
      create: (reminder: NativeReminders.Parsed) => run((store) => store.create(reminder)),
      complete: (id: number) => run((store) => store.complete(id)),
      snooze: (id: number, due: number) => run((store) => store.snooze(id, due)),
      delete: (id: number) => run((store) => store.delete(id)),
    }
  },
})

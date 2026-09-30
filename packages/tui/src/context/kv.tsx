import { createSignal, onCleanup, type Setter } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { missing, readJson, writeJsonAtomic } from "../util/persistence"
import { createPersistentState } from "../util/persistent-state"
import { useShutdown } from "./shutdown"
import { useTuiPaths } from "./runtime"
import path from "path"

export const { use: useKV, provider: KVProvider } = createSimpleContext({
  name: "KV",
  init: () => {
    const paths = useTuiPaths()
    const shutdown = useShutdown()
    const file = path.join(paths.state, "kv.json")
    const [ready, setReady] = createSignal(false)
    const [store, setStore] = createStore<Record<string, any>>()
    const state = createPersistentState({
      file,
      initial: {} as Record<string, unknown>,
      read: () =>
        readJson<Record<string, unknown>>(file).catch((error: unknown) => {
          if (missing(error)) return {}
          throw error
        }),
      write: (value) => writeJsonAtomic(file, value),
      onChange: (value) => setStore(value),
      onError: (error) => console.error("Failed to persist KV state", { error }),
    })
    onCleanup(() => shutdown(state.dispose()))
    void state.ready
      .catch(() => {})
      .finally(() => {
        setReady(true)
      })

    const result = {
      get ready() {
        return ready()
      },
      get store() {
        return store
      },
      signal<T>(name: string, defaultValue: T) {
        if (store[name] === undefined) setStore(name, defaultValue)
        return [
          function () {
            return result.get(name)
          },
          function setter(next: Setter<T>) {
            result.set(name, next)
          },
        ] as const
      },
      get(key: string, defaultValue?: any) {
        return store[key] ?? defaultValue
      },
      set(key: string, value: any) {
        setStore(key, value)
        const saved = structuredClone(unwrap(store[key]))
        void state.update((current) => ({ ...current, [key]: saved })).catch(() => {})
      },
    }
    return result
  },
})

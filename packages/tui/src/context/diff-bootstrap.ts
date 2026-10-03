import { createEffect, createSignal, onMount, untrack } from "solid-js"
import { useRoute } from "./route"

// Admission is permanent: closing diff while requests are pending, then reopening
// it, must not cancel or restart the normal provider bootstrap.
export function createDiffBootstrap(run: () => void, defer = true) {
  const route = useRoute()
  const initial = defer && route.data.type === "plugin" && route.data.id === "diff"
  const [admitted, setAdmitted] = createSignal(!initial)
  onMount(() => {
    let started = false
    createEffect(() => {
      if (started) return
      if (initial && route.data.type === "plugin" && route.data.id === "diff") return
      started = true
      setAdmitted(true)
      untrack(run)
    })
  })
  return { initial, deferred: () => !admitted() }
}

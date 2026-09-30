import { createSimpleContext } from "./helper"
import type { PromptRef } from "../component/prompt"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { useTuiStartup } from "./runtime"
import { useLocal } from "./local"
import { useSync } from "./sync"

export const { use: usePromptRef, provider: PromptRefProvider } = createSimpleContext({
  name: "PromptRef",
  init: () => {
    const [current, setCurrent] = createSignal<PromptRef>()
    const early = useTuiStartup().earlyInput
    const local = useLocal()
    const sync = useSync()
    const claim = () => {
      const ref = current()
      if (!early?.active || !ref || !sync.ready || !local.model.ready) return
      const pending = early.read()
      const token = pending.text.split(/\s/)[0]
      const serverCommand =
        pending.submit &&
        early.presentation?.slashes?.items.find((item) => !item.command && (item.value ?? item.display) === token)
      if (
        serverCommand &&
        sync.status !== "complete" &&
        !sync.data.command.some((command) => "/" + command.name === token)
      )
        return
      // Ref binding precedes onMount's unsaved-prompt restoration. Adopt after
      // mount and route/slot updates have settled, into the still-current ref.
      queueMicrotask(() => {
        if (current() !== ref) return
        const draft = early.claim()
        if (!draft) return
        if (ref.adoptStartupDraft) {
          ref.adoptStartupDraft(draft)
          return
        }
        // Plugin prompt replacements can opt into cursor-aware adoption; their
        // existing PromptRef.set contract still gets a lossless text handoff.
        if (!draft.text) return
        ref.set({
          ...ref.current,
          input: ref.current.input + (ref.current.input ? "\n" : "") + draft.text,
        })
        ref.focus()
      })
    }
    if (early) onCleanup(early.subscribe(claim))
    createEffect(claim)

    return {
      get current() {
        return current()
      },
      set(ref: PromptRef | undefined) {
        setCurrent(ref)
      },
    }
  },
})

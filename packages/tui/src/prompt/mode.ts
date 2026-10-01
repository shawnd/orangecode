import { createSignal } from "solid-js"
import type { PromptMode } from "./traits"

export function createPromptMode(
  agents: () => string[],
  current: () => string | undefined,
  select: (name: string) => void,
) {
  const [mode, setMode] = createSignal<PromptMode>("normal")
  return {
    mode,
    setMode,
    move(direction: 1 | -1) {
      const names = agents()
      const options = [
        undefined,
        ...["plan", "build"].filter((name) => names.includes(name)),
        ...names.filter((name) => name !== "plan" && name !== "build"),
      ]
      const index = mode() === "shell" ? 0 : options.indexOf(current())
      const next = options[(index + direction + options.length) % options.length]
      if (next === undefined) {
        setMode("shell")
        return
      }
      select(next)
      setMode("normal")
    },
  }
}

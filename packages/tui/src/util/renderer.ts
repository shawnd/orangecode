import { createCliRenderer, type CliRenderer, type CliRendererConfig } from "@opentui/core"
import type { EarlyInput } from "../context/runtime"

export async function createInputRenderer(config: CliRendererConfig, early?: EarlyInput) {
  const state: { renderer?: CliRenderer; cancelled: boolean } = { cancelled: false }
  const stdout = config.stdout ?? process.stdout
  let pending = Boolean(early?.active)
  const reveal = () => {
    if (!pending) return
    pending = false
    state.renderer?.off("frame", reveal)
    state.renderer?.off("destroy", reveal)
    stdout.write("\x1b[?2026l")
  }
  // Install the bridge before the async factory starts: cancellation during
  // terminal setup must not process.exit() or miss a not-yet-bound renderer.
  early?.onCancel(() => {
    state.cancelled = true
    if (state.renderer) destroyRenderer(state.renderer)
  })
  // Terminal setup re-enters the alternate screen and performs visible width
  // probes. Keep the preload on screen until the first native frame replaces it.
  // OpenTUI's own frame ends synchronized output; reveal also covers teardown
  // before that frame and terminals for which native sync support is disabled.
  if (pending) stdout.write("\x1b[?2026h")
  const renderer = await createCliRenderer(config).catch((error) => {
    reveal()
    throw error
  })
  state.renderer = renderer
  if (renderer.isDestroyed) reveal()
  if (!renderer.isDestroyed && pending) {
    renderer.once("frame", reveal)
    renderer.once("destroy", reveal)
    // Re-entering the alternate screen erases the preload. Restore its foreground
    // immediately instead of relying on synchronized output to hold the previous
    // screen until Solid mounts and paints its first frame.
    if (!state.cancelled) early?.redraw?.()
  }
  // Native signal handlers call renderer.destroy() directly. The destroy event
  // still owns the native handle; onDestroy runs after that handle is released.
  if (!renderer.isDestroyed) renderer.once("destroy", () => renderer.setTerminalTitle(""))
  if (state.cancelled) destroyRenderer(renderer)
  return renderer
}

export function destroyRenderer(renderer: Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "destroy">) {
  if (renderer.isDestroyed) return
  renderer.setTerminalTitle("")
  renderer.destroy()
}

import { createCliRenderer, type CliRenderer, type CliRendererConfig } from "@opentui/core"
import type { EarlyInput } from "../context/runtime"

export async function createInputRenderer(config: CliRendererConfig, early?: EarlyInput) {
  const state: { renderer?: CliRenderer; cancelled: boolean } = { cancelled: false }
  // Install the bridge before the async factory starts: cancellation during
  // terminal setup must not process.exit() or miss a not-yet-bound renderer.
  early?.onCancel(() => {
    state.cancelled = true
    if (state.renderer) destroyRenderer(state.renderer)
  })
  const renderer = await createCliRenderer(config)
  state.renderer = renderer
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

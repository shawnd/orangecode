/** @jsxImportSource @opentui/solid */
import { expect, mock } from "bun:test"
import { InputRenderable, type CliRendererConfig } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { ModelFavorites } from "@opencode-ai/core/model-favorites"
import { createTuiResolvedConfig } from "./tui-runtime"
import { createEventSource, createFetch, directory, json } from "./tui-sdk"

let onDestroy: CliRendererConfig["onDestroy"]
const view = await createTestRenderer({ width: 100, height: 30, useThread: false, onDestroy: () => onDestroy?.() })
const core = await import("@opentui/core")
mock.module("@opentui/core", () => ({
  ...core,
  createCliRenderer: async (config: CliRendererConfig) => {
    onDestroy = config.onDestroy
    return view.renderer
  },
}))

const model = { providerID: "shutdown-provider", modelID: "shutdown-model" }
const provider = {
  id: model.providerID,
  name: "Shutdown Provider",
  models: {
    [model.modelID]: {
      id: model.modelID,
      providerID: model.providerID,
      name: "Shutdown Model",
      release_date: "2026-09-30",
      cost: { input: 1 },
      variants: {},
    },
  },
}
const fetch = createFetch((url) => {
  if (url.pathname === "/config/providers") return json({ providers: [provider], default: {} })
  if (url.pathname === "/provider") return json({ all: [provider], connected: [provider.id], default: {} })
  if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", permission: [], options: {} }])
})
const ready = Promise.withResolvers<TuiPluginApi>()
const { run } = await import("../../src/app")
const task = Effect.runPromise(
  run({
    url: "http://test",
    directory,
    config: createTuiResolvedConfig({ plugin_enabled: {} }),
    fetch: fetch.fetch,
    events: createEventSource().source,
    args: {},
    pluginHost: {
      async start(input) {
        ready.resolve(input.api)
      },
      async dispose() {},
    },
  }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
)
const api = await ready.promise
api.keymap.dispatchCommand("model.list")
const deadline = Date.now() + 3000
while (!(view.renderer.currentFocusedEditor instanceof InputRenderable)) {
  if (Date.now() > deadline) throw new Error("Model picker did not mount")
  await view.renderOnce()
  await Bun.sleep(10)
}

// Admit the favorite and close immediately in the same input turn, without
// waiting for the optimistic badge, SQLite initialization, or the write promise.
view.mockInput.pressKey("f", { ctrl: true })
view.mockInput.pressKey("c", { ctrl: true }) // Close the picker.
view.mockInput.pressKey("c", { ctrl: true }) // Exit the idle TUI.
await task
expect(view.renderer.isDestroyed).toBe(true)

const favorites = ModelFavorites.store()
expect(await favorites.list()).toEqual([model])
await favorites.dispose()
console.log("favorite survived immediate Ctrl+C")

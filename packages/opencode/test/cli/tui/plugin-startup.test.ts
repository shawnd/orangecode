import { expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { createPluginRuntime } from "@opencode-ai/tui/plugin/runtime"
import { TuiConfig } from "../../../src/config/tui"
import { tmpdir } from "../../fixture/fixture"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const { TuiPluginRuntime, createLegacyTuiPluginHost } = await import("../../../src/plugin/tui/runtime")

async function startup(dir: string, enabled: Record<string, boolean> = {}) {
  const mod = path.join(dir, "pending-plugin")
  await fs.mkdir(mod)
  const spec = pathToFileURL(mod).href
  const gate = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  const wait = spyOn(TuiConfig, "waitForDependencies").mockImplementation(() => {
    waiting.resolve()
    return gate.promise
  })
  const cwd = spyOn(process, "cwd").mockImplementation(() => dir)
  const config = createTuiResolvedConfig({
    plugin: [spec],
    plugin_origins: [{ spec, scope: "local", source: path.join(dir, "tui.json") }],
    plugin_enabled: enabled,
  })
  const api = createTuiPluginApi()
  const runtime = createPluginRuntime()
  const routes = spyOn(api.route, "register").mockImplementation(runtime.routes.register)
  const host = createLegacyTuiPluginHost()
  const previous = process.env.OPENCODE_PLUGIN_META_FILE
  process.env.OPENCODE_PLUGIN_META_FILE = path.join(dir, "plugin-meta.json")
  let callbacks = 0

  return {
    api,
    config,
    runtime,
    host,
    routes,
    ready: ready.promise,
    waiting: waiting.promise,
    release: gate.resolve,
    get callbacks() {
      return callbacks
    },
    onBuiltinsReady() {
      callbacks += 1
      ready.resolve()
    },
    async install(fail = false) {
      await Bun.write(
        path.join(mod, "index.ts"),
        fail
          ? `throw new Error("external load failed")\n`
          : `export default {
  id: "demo.startup",
  tui: async (api) => {
    api.route.register([{ name: "diff", render: () => null }])
    api.kv.set("external_started", true)
  },
}\n`,
      )
    },
    async [Symbol.asyncDispose]() {
      gate.resolve()
      await host.dispose()
      cwd.mockRestore()
      wait.mockRestore()
      routes.mockRestore()
      if (previous === undefined) delete process.env.OPENCODE_PLUGIN_META_FILE
      if (previous !== undefined) process.env.OPENCODE_PLUGIN_META_FILE = previous
    },
  }
}

test("builtins become ready before external dependencies, preserving disabled state and override order", async () => {
  await using tmp = await tmpdir()
  await using input = await startup(tmp.path, { "internal:plugin-manager": false })
  const task = input.host.start(input)
  await input.ready
  await input.waiting

  expect(input.callbacks).toBe(1)
  expect(TuiPluginRuntime.list().find((item) => item.id === "diff-viewer")).toMatchObject({
    active: true,
    enabled: true,
  })
  expect(TuiPluginRuntime.list().find((item) => item.id === "internal:plugin-manager")).toMatchObject({
    active: false,
    enabled: false,
  })
  expect(TuiPluginRuntime.list().find((item) => item.id === "which-key")).toMatchObject({
    active: false,
    enabled: false,
  })
  const builtin = input.runtime.routes.get("diff")
  expect(builtin).toBeDefined()
  expect(input.api.kv.get("external_started", false)).toBe(false)
  const registrations = input.routes.mock.calls.length

  await input.runtime.commands().deactivate("internal:home-footer")
  await input.runtime.commands().activate("which-key")
  // A settings update during resolution must not reapply startup defaults to live builtins.
  input.api.kv.set("plugin_enabled", {})
  await input.install()
  input.release()
  await task

  expect(input.callbacks).toBe(1)
  expect(input.routes.mock.calls.length).toBe(registrations + 1)
  expect(TuiPluginRuntime.list().find((item) => item.id === "which-key")?.active).toBe(true)
  expect(TuiPluginRuntime.list().find((item) => item.id === "internal:home-footer")?.active).toBe(false)
  expect(TuiPluginRuntime.list().at(-1)?.id).toBe("demo.startup")
  expect(input.runtime.routes.get("diff")).not.toBe(builtin)
  expect(input.api.kv.get("external_started", false)).toBe(true)
  await input.runtime.commands().deactivate("demo.startup")
  expect(input.runtime.routes.get("diff")).toBe(builtin)
})

test("omitting callback keeps builtins inactive until external resolution finishes", async () => {
  await using tmp = await tmpdir()
  await using input = await startup(tmp.path)
  const task = input.host.start({ api: input.api, config: input.config, runtime: input.runtime })
  await input.waiting

  expect(input.callbacks).toBe(0)
  expect(TuiPluginRuntime.list().every((item) => !item.active)).toBe(true)
  expect(input.runtime.routes.get("diff")).toBeUndefined()
  await input.install()
  input.release()
  await task

  expect(TuiPluginRuntime.list().find((item) => item.id === "diff-viewer")?.active).toBe(true)
  expect(input.routes.mock.calls.filter(([list]) => list.some((route) => route.name === "diff"))).toHaveLength(2)
  await input.runtime.commands().deactivate("demo.startup")
  expect(input.runtime.routes.get("diff")).toBeDefined()
})

test("callback fires with diff builtin disabled by persisted user state", async () => {
  await using tmp = await tmpdir()
  await using input = await startup(tmp.path, { "diff-viewer": true })
  input.api.kv.set("plugin_enabled", { "diff-viewer": false, "demo.startup": false })
  const task = input.host.start(input)
  await input.ready
  await input.waiting

  expect(input.callbacks).toBe(1)
  expect(TuiPluginRuntime.list().find((item) => item.id === "diff-viewer")).toMatchObject({
    active: false,
    enabled: false,
  })
  expect(input.runtime.routes.get("diff")).toBeUndefined()
  await input.install()
  input.release()
  await task

  expect(TuiPluginRuntime.list().find((item) => item.id === "demo.startup")).toMatchObject({
    active: false,
    enabled: false,
  })
  expect(input.api.kv.get("plugin_enabled", {})).toEqual({ "diff-viewer": false, "demo.startup": false })
})

test("external load failure leaves ready builtins active", async () => {
  await using tmp = await tmpdir()
  await using input = await startup(tmp.path)
  const task = input.host.start(input)
  await input.ready
  await input.waiting
  const builtin = input.runtime.routes.get("diff")
  await input.install(true)
  input.release()
  await task

  expect(input.callbacks).toBe(1)
  expect(TuiPluginRuntime.list().find((item) => item.id === "diff-viewer")?.active).toBe(true)
  expect(input.runtime.routes.get("diff")).toBe(builtin)
  expect(TuiPluginRuntime.list().some((item) => item.id === "demo.startup")).toBe(false)
})

test("disposing during external resolution cleans builtins and prevents stale activation after restart", async () => {
  await using tmp = await tmpdir()
  await using input = await startup(tmp.path)
  const task = input.host.start(input)
  await input.ready
  await input.waiting
  await input.host.dispose()

  expect(TuiPluginRuntime.list()).toEqual([])
  expect(input.runtime.status()).toEqual([])
  expect(input.runtime.routes.get("diff")).toBeUndefined()
  const registrations = input.routes.mock.calls.length
  const next = createPluginRuntime()
  await input.host.start({
    api: createTuiPluginApi(),
    config: createTuiResolvedConfig({ plugin_origins: [] }),
    runtime: next,
  })
  await input.install()
  input.release()
  await task

  expect(input.callbacks).toBe(1)
  expect(input.routes.mock.calls.length).toBe(registrations)
  expect(input.api.kv.get("external_started", false)).toBe(false)
  expect(input.runtime.status()).toEqual([])
  expect(TuiPluginRuntime.list().some((item) => item.id === "demo.startup")).toBe(false)
  expect(next.status().find((item) => item.id === "diff-viewer")?.active).toBe(true)
})

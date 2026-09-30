import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import type { CliRendererConfig } from "@opentui/core"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const events = createEventSource()
  const calls = createFetch()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposes = 0

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(disposes).toBe(1)
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("app.exit prints the session epilogue after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session")
      return json([
        {
          id: "dummy",
          title: "Demo session",
          slug: "dummy",
          projectID: "project",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        },
      ])
  })
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    api?.keymap.dispatchCommand("app.exit")
    await task

    expect(stdout).toContain("Demo session")
    expect(stdout).toContain("oc -s dummy")
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test.each([false, true])("/restart is visible and preserves location after cleanup (session=%s)", async (session) => {
  let onDestroy: CliRendererConfig["onDestroy"]
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false, onDestroy: () => onDestroy?.() })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({
    ...core,
    createCliRenderer: async (config: CliRendererConfig) => {
      onDestroy = config.onDestroy
      return setup.renderer
    },
  }))
  const info = {
    id: "dummy",
    title: "Restart session",
    slug: "dummy",
    projectID: "project",
    directory,
    version: "0.0.0-test",
    time: { created: 0, updated: 0 },
  }
  const provider = {
    id: "test",
    name: "Test provider",
    models: {
      test: {
        id: "test",
        providerID: "test",
        name: "Test model",
        family: "test",
        api: { id: "test", url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
        limit: { context: 100000, output: 10000 },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        capabilities: { temperature: true, reasoning: false, attachment: false, toolcall: true },
        variants: {},
        release_date: "2026-01-01",
      },
    },
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: { test: "test" } })
    if (url.pathname === "/provider") return json({ all: [provider], default: { test: "test" }, connected: ["test"] })
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", permission: [], options: {} }])
    if (url.pathname === "/session") return json([info])
    if (url.pathname === "/session/dummy") return json(info)
    if (url.pathname.startsWith("/session/dummy/")) return json([])
  })
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposes = 0
  const originalExitCode = process.exitCode ?? 0
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: createEventSource().source,
        args: session ? { continue: true } : {},
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {
            expect(setup.renderer.isDestroyed).toBe(true)
            disposes++
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    const entry = api?.keymap
      .getCommandEntries({ visibility: "reachable", namespace: "palette" })
      .find((entry) => entry.command.slashName === "restart" && entry.command.hidden !== true)
    expect(entry?.command.name).toBe("app.restart")
    api?.keymap.dispatchCommand("app.restart")
    expect(await task).toEqual({ sessionID: session ? "dummy" : undefined, directory })
    expect(disposes).toBe(1)
    expect(stdout).not.toContain("oc -s dummy")
    expect(process.exitCode ?? 0).toBe(originalExitCode)
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("fatal startup errors set a nonzero exit after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  await mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/config")
      return json(
        {
          name: "ConfigRemoteAuthError",
          data: {
            url: "https://example.com",
            remote: "https://config.example.com/opencode.json",
          },
        },
        { status: 400 },
      )
    return undefined
  })
  let disposes = 0
  const originalWrite = process.stderr.write.bind(process.stderr)
  const originalExitCode = process.exitCode ?? 0
  let stderr = ""

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {},
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await task
    expect(stderr).toContain("Run `oc auth login https://example.com` to re-authenticate.")
    expect(stderr).not.toContain("Unexpected server error")
    expect(process.exitCode).toBe(1)
    expect(setup.renderer.isDestroyed).toBe(true)
    expect(disposes).toBe(1)
  } finally {
    process.stderr.write = originalWrite
    process.exitCode = originalExitCode
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

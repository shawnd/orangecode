import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import type { CliRendererConfig } from "@opentui/core"
import { Effect, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"
import { tmpdir } from "./fixture/fixture"
import path from "path"
import type { EarlyInput } from "../src/context/runtime"

let root: Awaited<ReturnType<typeof tmpdir>>
beforeEach(async () => {
  root = await tmpdir()
})
afterEach(async () => {
  await root[Symbol.asyncDispose]()
})
const testGlobal = () =>
  Layer.succeed(Global.Service, { ...Global.Path, home: root.path, state: root.path, data: root.path })

test.each(["renderer", "takeover"])(
  "startup failure during %s releases the plugin host before it starts",
  async (phase) => {
    const core = await import("@opentui/core")
    let rendererCalls = 0
    mock.module("@opentui/core", () => ({
      ...core,
      createCliRenderer: async () => {
        rendererCalls++
        throw new Error("renderer setup failed")
      },
    }))
    let started = 0
    let disposed = 0
    let inputDisposed = 0
    const early: EarlyInput = {
      active: true,
      read: () => ({ text: "", cursor: 0 }),
      subscribe: () => () => {},
      takeover: async () => {
        throw new Error("input takeover failed")
      },
      onCancel() {},
      claim: () => undefined,
      dispose() {
        inputDisposed++
      },
    }
    try {
      const { run } = await import("../src/app")
      await expect(
        Effect.runPromise(
          run({
            url: "http://test",
            directory,
            config: createTuiResolvedConfig({ plugin_enabled: {} }),
            fetch: createFetch().fetch,
            events: createEventSource().source,
            args: {},
            earlyInput: phase === "takeover" ? early : undefined,
            pluginHost: {
              async start() {
                started++
              },
              async dispose() {
                disposed++
              },
            },
          }).pipe(Effect.provide(testGlobal())),
        ),
      ).rejects.toThrow(phase === "takeover" ? "input takeover failed" : "renderer setup failed")
      expect(started).toBe(0)
      expect(disposed).toBe(1)
      expect(rendererCalls).toBe(phase === "renderer" ? 1 : 0)
      expect(inputDisposed).toBe(phase === "takeover" ? 1 : 0)
    } finally {
      mock.restore()
    }
  },
)

test("immediate Ctrl+C flushes a newly favorited model and the subprocess exits naturally", async () => {
  await using tmp = await tmpdir()
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/favorite-exit.tsx")], {
    env: {
      ...process.env,
      XDG_DATA_HOME: path.join(tmp.path, "data"),
      XDG_STATE_HOME: path.join(tmp.path, "state"),
      XDG_CONFIG_HOME: path.join(tmp.path, "config"),
      OPENCODE_DB: path.join(tmp.path, "opencode.db"),
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(stdout).toContain("favorite survived immediate Ctrl+C")
  } finally {
    if (child.exitCode === null) child.kill()
  }
}, 10_000)

test("SIGHUP clears title and disposes scoped resources once", async () => {
  let onDestroy: CliRendererConfig["onDestroy"]
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false, onDestroy: () => onDestroy?.() })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({
    ...core,
    createCliRenderer: async (config: CliRendererConfig) => {
      expect(config.useKittyKeyboard?.events).toBe(true)
      onDestroy = config.onDestroy
      return setup.renderer
    },
  }))
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
      }).pipe(Effect.provide(testGlobal())),
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
  let disposes = 0
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
          async dispose() {
            expect(setup.renderer.isDestroyed).toBe(true)
            expect(stdout).not.toContain("oc -s dummy")
            disposes++
          },
        },
      }).pipe(Effect.provide(testGlobal())),
    )

    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    api?.keymap.dispatchCommand("app.exit")
    await task

    expect(stdout).toContain("Demo session")
    expect(stdout).toContain("oc -s dummy")
    expect(disposes).toBe(1)
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
      }).pipe(Effect.provide(testGlobal())),
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
  let onDestroy: CliRendererConfig["onDestroy"]
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false, onDestroy: () => onDestroy?.() })
  const core = await import("@opentui/core")
  await mock.module("@opentui/core", () => ({
    ...core,
    createCliRenderer: async (config: CliRendererConfig) => {
      onDestroy = config.onDestroy
      return setup.renderer
    },
  }))
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
      }).pipe(Effect.provide(testGlobal())),
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

/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { MouseButton } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { Prompt, type PromptRef } from "../../../src/component/prompt"
import { FrecencyProvider } from "../../../src/component/prompt/frecency"
import { DialogModel } from "../../../src/component/dialog-model"
import { DialogProvider } from "../../../src/component/dialog-provider"
import { DialogVariant } from "../../../src/component/dialog-variant"
import { TuiConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { DataProvider } from "../../../src/context/data"
import { EditorContextProvider } from "../../../src/context/editor"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider, useKV } from "../../../src/context/kv"
import { LocalProvider, useLocal } from "../../../src/context/local"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useBindings } from "../../../src/keymap"
import { PromptHistoryProvider, usePromptHistory } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createFetch, createEventSource, directory, json, worktree } from "../../fixture/tui-sdk"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { RemindersProvider } from "../../../src/context/reminders"
import { NativeReminders } from "@opencode-ai/core/native/reminders"

async function mount(root: string, sessionID?: string, variants = true) {
  const events = createEventSource()
  const aborted: string[] = []
  const dialogUI = await import("../../../src/ui/dialog")
  await Bun.write(`${root}/kv.json`, JSON.stringify({ animations_enabled: false }))
  const provider = {
    id: "metadata-provider",
    name: "Metadata Provider",
    models: {
      "metadata-model": {
        id: "metadata-model",
        providerID: "metadata-provider",
        name: "Metadata Model",
        family: "test",
        api: { id: "metadata-model", url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
        limit: { context: 100000, output: 10000 },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        capabilities: { temperature: true, reasoning: true, attachment: false, toolcall: true },
        variants: variants ? { high: {}, low: {} } : {},
        release_date: "2026-01-01",
      },
    },
  }
  Object.assign(
    provider.models,
    Object.fromEntries(
      ["second", "third"].map((name) => [
        `${name}-model`,
        { ...provider.models["metadata-model"], id: `${name}-model`, name: `${name} Model` },
      ]),
    ),
  )
  const other = { ...provider, id: "other-provider", name: "Other Provider" }
  const calls = createFetch((url) => {
    if (url.pathname.endsWith("/abort")) {
      aborted.push(url.pathname)
      return json(true)
    }
    if (url.pathname === "/config") return json({ model: "metadata-provider/metadata-model" })
    if (url.pathname === "/config/providers")
      return json({ providers: [provider, other], default: { "metadata-provider": "metadata-model" } })
    if (url.pathname === "/provider")
      return json({
        all: [provider, other],
        default: { "metadata-provider": "metadata-model" },
        connected: [provider.id, other.id],
      })
    if (url.pathname === "/agent")
      return json(["build", "plan"].map((name) => ({ name, mode: "primary", permission: [], options: {} })))
    if (url.pathname.startsWith("/session/")) return json([])
  })
  let context:
    | {
        local: ReturnType<typeof useLocal>
        dialog: ReturnType<typeof useDialog>
        route: ReturnType<typeof useRoute>
        history: ReturnType<typeof usePromptHistory>
        kv: ReturnType<typeof useKV>
      }
    | undefined
  let prompt: PromptRef | undefined
  function Controls() {
    const local = useLocal()
    const dialog = useDialog()
    const sync = useSync()
    context = { local, dialog, route: useRoute(), history: usePromptHistory(), kv: useKV() }
    // Register app-level commands so clicks exercise real keymap dispatch and picker components.
    useBindings(() => ({
      commands: [
        {
          name: "agent.cycle",
          namespace: "palette",
          title: "Switch agent",
          slashName: "agents",
          run: () => local.agent.move(1),
        },
        {
          name: "model.list",
          namespace: "palette",
          title: "Switch model",
          slashName: "models",
          run: () => dialog.replace(() => <DialogModel />),
        },
        { name: "provider.connect", run: () => dialog.replace(() => <DialogProvider />) },
        { name: "variant.list", run: () => dialog.replace(() => <DialogVariant />) },
      ],
    }))
    return (
      <box paddingTop={10}>
        <Prompt
          sessionID={sessionID}
          visible={sync.ready}
          ref={(ref) => {
            prompt = ref
          }}
        />
      </box>
    )
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ theme: "opencode" })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={directory} paths={{ state: root, home: root, worktree }}>
        <ArgsProvider>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                      <PermissionProvider>
                        <ProjectProvider>
                          <ExitProvider
                            exit={(error) => {
                              throw error ?? new Error("Unexpected exit")
                            }}
                          >
                            <SyncProvider>
                              <DataProvider>
                                <RouteProvider>
                                  <LocalProvider>
                                    <ClipboardProvider value={{}}>
                                      <PromptStashProvider>
                                        <RemindersProvider>
                                          <dialogUI.DialogProvider>
                                            <FrecencyProvider>
                                              <PromptHistoryProvider>
                                                <EditorContextProvider>
                                                  <LocationProvider>
                                                    <Controls />
                                                  </LocationProvider>
                                                </EditorContextProvider>
                                              </PromptHistoryProvider>
                                            </FrecencyProvider>
                                          </dialogUI.DialogProvider>
                                        </RemindersProvider>
                                      </PromptStashProvider>
                                    </ClipboardProvider>
                                  </LocalProvider>
                                </RouteProvider>
                              </DataProvider>
                            </SyncProvider>
                          </ExitProvider>
                        </ProjectProvider>
                      </PermissionProvider>
                    </SDKProvider>
                  </ToastProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </ArgsProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width: 120, height: 30 })
  const waitForFrame = async (predicate: (frame: string) => boolean) => {
    const deadline = Date.now() + 2000
    while (true) {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      if (predicate(frame)) return frame
      if (Date.now() > deadline) throw new Error(`Timed out waiting for prompt frame:\n${frame}`)
      await Bun.sleep(10)
    }
  }
  return {
    app,
    events,
    aborted,
    prompt() {
      if (!prompt) throw new Error("Prompt not ready")
      return prompt
    },
    waitForFrame,
    async click(label: string, button: MouseButton.LEFT | MouseButton.RIGHT = MouseButton.LEFT) {
      const frame = await waitForFrame((frame) => frame.includes(label))
      const lines = frame.split("\n")
      const y = lines.findIndex((line) => line.includes(label))
      await app.mockMouse.click(lines[y].indexOf(label) + 1, y, button)
    },
    ctx() {
      if (!context) throw new Error("Prompt contexts not ready")
      return context
    },
    [Symbol.dispose]() {
      app.renderer.destroy()
    },
  }
}

function runningTask(view: Awaited<ReturnType<typeof mount>>) {
  view.events.emit({
    directory,
    payload: { id: "busy", type: "session.status", properties: { sessionID: "child", status: { type: "busy" } } },
  })
  const part: ToolPart = {
    id: "task-part",
    sessionID: "parent",
    messageID: "parent-message",
    callID: "task-call",
    type: "tool",
    tool: "task",
    state: {
      status: "completed",
      input: {},
      output: "started",
      title: "Inspect cache",
      metadata: { sessionId: "child", background: true },
      time: { start: 1, end: 2 },
    },
  }
  view.events.emit({
    directory,
    payload: {
      id: "task-started",
      type: "message.part.updated",
      properties: { part, sessionID: part.sessionID, time: 2 },
    },
  })
  return part
}

test("idle parent keeps background count beside path and Escape aborts the entire session", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path, "parent")
  await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  runningTask(view)
  const frame = await view.waitForFrame((frame) => frame.includes("1 background agent"))
  expect(frame.split("\n").find((line) => line.includes("1 background agent"))).toContain(directory)
  view.app.mockInput.pressEscape()
  await view.waitForFrame((frame) => frame.includes("again to interrupt"))
  view.app.mockInput.pressEscape()
  await view.waitForFrame(() => view.aborted.length === 1)
  expect(view.aborted).toEqual(["/session/parent/abort"])
  view.events.emit({
    directory,
    payload: { id: "idle", type: "session.status", properties: { sessionID: "child", status: { type: "idle" } } },
  })
  await view.waitForFrame((frame) => !frame.includes("background agent"))
  view.events.emit({
    directory,
    payload: {
      id: "parent-working",
      type: "session.status",
      properties: { sessionID: "parent", status: { type: "busy" } },
    },
  })
  const working = await view.waitForFrame((frame) => frame.includes("[⋯]"))
  const lines = working.split("\n")
  const pathRow = lines.findIndex((line) => line.includes(directory))
  const progressRow = lines.findIndex((line) => line.includes("[⋯]"))
  expect(pathRow).toBeGreaterThanOrEqual(0)
  expect(progressRow).toBe(pathRow + 1)
  expect(lines[progressRow]).toContain("esc interrupt")
  expect(working).not.toContain("interrupt all")
})

test("agent count opens a live list by click or Down/Enter and switches to the selected agent", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path, "parent")
  await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  runningTask(view)
  await view.click("1 background agent")
  await view.waitForFrame((frame) => frame.includes("Background agents") && frame.includes("Inspect cache"))
  view.ctx().dialog.clear()
  await view.app.renderOnce()
  view.app.mockInput.pressArrow("down")
  await view.app.renderOnce()
  view.app.mockInput.pressArrow("up")
  await view.app.renderOnce()
  view.app.mockInput.pressEnter()
  await view.app.renderOnce()
  expect(view.ctx().dialog.stack).toHaveLength(0)
  view.app.mockInput.pressArrow("down")
  await view.app.renderOnce()
  view.app.mockInput.pressEnter()
  await view.waitForFrame((frame) => frame.includes("Background agents"))
  view.app.mockInput.pressEnter()
  await view.waitForFrame(() => view.ctx().route.data.type === "session")
  expect(view.ctx().route.data).toMatchObject({ type: "session", sessionID: "child" })
})

test("background agent activity keeps animating before Escape while the parent is idle", async () => {
  await using tmp = await tmpdir()
  await using view = await mount(tmp.path, "parent")
  await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  view.ctx().kv.set("animations_enabled", true)
  runningTask(view)
  const beforeEscape = (frame: string) => {
    const line = frame.split("\n").find((line) => line.includes("esc interrupt")) ?? ""
    return line.slice(0, line.indexOf("esc interrupt")).trim()
  }
  const first = await view.waitForFrame(
    (frame) =>
      frame.includes("1 background agent") && beforeEscape(frame).length > 0 && !beforeEscape(frame).includes("[⋯]"),
  )
  const next = await view.waitForFrame(
    (frame) =>
      frame.includes("1 background agent") &&
      beforeEscape(frame).length > 0 &&
      beforeEscape(frame) !== beforeEscape(first),
  )
  expect(beforeEscape(next)).not.toBe(beforeEscape(first))
  view.events.emit({
    directory,
    payload: { id: "agent-idle", type: "session.status", properties: { sessionID: "child", status: { type: "idle" } } },
  })
  await view.waitForFrame((frame) => !frame.includes("background agent") && !frame.includes("esc interrupt"))
})

test("input history keeps arrow priority until returning to the draft, then Down enters background agents", async () => {
  await using tmp = await tmpdir()
  await using view = await mount(tmp.path, "parent")
  await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  view.prompt().reset()
  view.ctx().history.append({ input: "older prompt", parts: [] })
  view.ctx().history.append({ input: "newer prompt", parts: [] })
  runningTask(view)
  await view.waitForFrame((frame) => frame.includes("1 background agent"))
  view.app.mockInput.pressArrow("up")
  await view.waitForFrame(() => view.prompt().current.input === "newer prompt")
  view.app.mockInput.pressArrow("up")
  await view.waitForFrame(() => view.prompt().current.input === "older prompt")
  // The first Down reaches the end of the recalled line; the next advances history.
  view.app.mockInput.pressArrow("down")
  await view.app.renderOnce()
  view.app.mockInput.pressArrow("down")
  await view.waitForFrame(() => view.prompt().current.input === "newer prompt")
  view.app.mockInput.pressArrow("down")
  await view.waitForFrame(() => view.prompt().current.input === "")
  expect(view.ctx().dialog.stack).toHaveLength(0)
  view.app.mockInput.pressArrow("down")
  await view.app.renderOnce()
  view.app.mockInput.pressEnter()
  await view.waitForFrame((frame) => frame.includes("Background agents"))
  view.ctx().dialog.clear()
  await view.app.renderOnce()
  view.app.mockInput.pressArrow("up")
  await view.waitForFrame(() => view.prompt().current.input === "newer prompt")
  view.prompt().set({ input: "edited recalled prompt", parts: [] })
  await view.app.renderOnce()
  view.app.mockInput.pressArrow("down")
  await view.app.renderOnce()
  view.app.mockInput.pressEnter()
  await view.waitForFrame((frame) => frame.includes("Background agents"))
  expect(view.prompt().current.input).toBe("edited recalled prompt")
  view.ctx().dialog.clear()
  view.prompt().reset()
})

test("shell footer selection opens live command output without submitting the draft", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path, "parent")
  await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  runningTask(view)
  const part: ToolPart = {
    id: "shell-part",
    sessionID: "child",
    messageID: "child-message",
    callID: "shell-call",
    type: "tool",
    tool: "bash",
    state: {
      status: "running",
      input: { command: "bun test" },
      title: "Tests",
      metadata: { output: "Starting tests" },
      time: { start: 3 },
    },
  }
  view.events.emit({
    directory,
    payload: {
      id: "shell-started",
      type: "message.part.updated",
      properties: { part, sessionID: part.sessionID, time: 3 },
    },
  })
  for (const type of ["busy", "idle"] as const) {
    view.events.emit({
      directory,
      payload: { id: `parent-${type}`, type: "session.status", properties: { sessionID: "parent", status: { type } } },
    })
    const frame = await view.waitForFrame(
      (frame) => frame.includes("1 shell") && frame.includes("1 background agent") && frame.includes("[⋯]"),
    )
    const lines = frame.split("\n")
    const agentRow = lines.findIndex((line) => line.includes("1 background agent"))
    const shellRow = lines.findIndex((line) => line.includes("1 shell"))
    expect(lines[agentRow]).toContain(directory)
    expect(shellRow).toBe(agentRow + 1)
    expect(lines[shellRow].indexOf("1 shell")).toBe(lines[agentRow].indexOf("1 background agent"))
    expect(lines[shellRow]).toContain("esc interrupt")
    expect(lines[shellRow].indexOf("[⋯]")).toBeLessThan(lines[shellRow].indexOf("esc interrupt"))
  }
  await view.click("1 shell")
  await view.waitForFrame((frame) => frame.includes("Running shells") && frame.includes("bun test"))
  view.ctx().dialog.clear()
  view.prompt().set({ input: "keep this draft", parts: [] })
  await view.app.renderOnce()
  view.app.mockInput.pressArrow("down")
  await view.app.renderOnce()
  view.app.mockInput.pressArrow("down")
  await view.app.renderOnce()
  view.app.mockInput.pressArrow("up")
  await view.app.renderOnce()
  view.app.mockInput.pressEnter()
  await view.waitForFrame((frame) => frame.includes("Background agents"))
  view.ctx().dialog.clear()
  await view.app.renderOnce()
  view.app.mockInput.pressArrow("down")
  await view.app.renderOnce()
  view.app.mockInput.pressArrow("down")
  await view.app.renderOnce()
  view.app.mockInput.pressArrow("down")
  await view.app.renderOnce()
  view.app.mockInput.pressEnter()
  await view.waitForFrame((frame) => frame.includes("Running shells") && frame.includes("bun test"))
  view.app.mockInput.pressEnter()
  await view.waitForFrame((frame) => frame.includes("Starting tests"))
  expect(view.prompt().current.input).toBe("keep this draft")
  view.events.emit({
    directory,
    payload: {
      id: "shell-completed",
      type: "message.part.updated",
      properties: {
        sessionID: part.sessionID,
        time: 4,
        part: {
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: "Tests",
            output: "All tests passed",
            metadata: {},
            time: { start: 3, end: 4 },
          },
        },
      },
    },
  })
  await view.waitForFrame((frame) => frame.includes("All tests passed"))
  view.ctx().dialog.clear()
  await view.waitForFrame((frame) => !frame.includes("1 shell"))
  view.prompt().reset()
})

test("a real background shell is inspectable and interruptible while its owner is idle", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path, "parent")
  await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  const part: ToolPart = {
    id: "background-shell",
    sessionID: "parent",
    messageID: "shell-message",
    callID: "shell-call",
    type: "tool",
    tool: "bash",
    state: {
      status: "completed",
      input: { command: "bun run build", background: true },
      title: "Build",
      output: "Job started",
      time: { start: 1, end: 2 },
      metadata: {
        background: true,
        jobId: "job_build",
        shellStatus: "running",
        stdinOpen: true,
        output: "Building module A",
        outputPath: "/tmp/build.log",
      },
    },
  }
  view.events.emit({
    directory,
    payload: {
      id: "bg-shell-started",
      type: "message.part.updated",
      properties: { sessionID: part.sessionID, part, time: 3 },
    },
  })
  const active = await view.waitForFrame((frame) => frame.includes("1 shell"))
  expect(active.split("\n").find((line) => line.includes("esc interrupt"))).toContain("[⋯]")
  await view.click("1 shell")
  await view.waitForFrame((frame) => frame.includes("Running shells"))
  view.app.mockInput.pressEnter()
  const frame = await view.waitForFrame((frame) => frame.includes("Building module A"))
  expect(frame).toContain("Shell · running")
  expect(frame).toContain("stdin open")
  expect(frame).toContain("/tmp/build.log")
  view.app.mockInput.pressEscape()
  await view.waitForFrame((frame) => !frame.includes("Building module A"))
  expect(view.aborted).toEqual([])
  view.app.mockInput.pressEscape()
  await view.waitForFrame((frame) => frame.includes("again to interrupt"))
  view.app.mockInput.pressEscape()
  await view.waitForFrame(() => view.aborted.length === 1)
  if (part.state.status !== "completed") throw new Error("Expected completed source call")
  view.events.emit({
    directory,
    payload: {
      id: "bg-shell-cancelled",
      type: "message.part.updated",
      properties: {
        sessionID: part.sessionID,
        time: 4,
        part: { ...part, state: { ...part.state, metadata: { ...part.state.metadata, shellStatus: "cancelled" } } },
      },
    },
  })
  await view.waitForFrame((frame) => !frame.includes("1 shell"))
})

for (const sessionID of [undefined, "metadata-session"]) {
  test(`prompt metadata controls work on ${sessionID ? "chat session" : "home"}`, async () => {
    await using tmp = await tmpdir()
    using view = await mount(tmp.path, sessionID)
    const frame = await view.waitForFrame((frame) => frame.includes("Metadata Model") && frame.includes("default"))
    expect(frame).toContain("Build")

    await view.click("Build")
    await view.waitForFrame((frame) => frame.includes("Plan"))
    expect(view.ctx().local.agent.current()?.name).toBe("plan")
    await view.click("Plan")
    await view.waitForFrame((frame) => frame.includes("Build"))
    expect(view.ctx().local.agent.current()?.name).toBe("build")

    await view.click("Metadata Model")
    await view.waitForFrame((frame) => frame.includes("second Model"))
    expect(view.ctx().local.model.current()).toEqual({ providerID: "metadata-provider", modelID: "second-model" })
    expect(view.ctx().dialog.stack.length).toBe(0)
    await view.click("second Model")
    await view.waitForFrame((frame) => frame.includes("third Model"))
    await view.click("third Model")
    await view.waitForFrame((frame) => frame.includes("Metadata Model"))
    await view.click("Metadata Model", MouseButton.RIGHT)
    await view.waitForFrame((frame) => frame.includes("third Model"))
    await view.click("third Model", MouseButton.RIGHT)
    await view.waitForFrame((frame) => frame.includes("second Model"))
    await view.click("second Model", MouseButton.RIGHT)
    await view.waitForFrame((frame) => frame.includes("Metadata Model"))
    expect(view.ctx().local.model.current()).toEqual({ providerID: "metadata-provider", modelID: "metadata-model" })
    expect(view.ctx().dialog.stack.length).toBe(0)

    await view.click("Metadata Provider")
    await view.waitForFrame((frame) => frame.includes("Connect a provider"))
    view.ctx().dialog.clear()

    await view.click("default")
    await view.waitForFrame((frame) => frame.includes("· high"))
    expect(view.ctx().local.model.variant.current()).toBe("high")
    await view.click("high")
    await view.waitForFrame((frame) => frame.includes("· low"))
    await view.click("low")
    await view.waitForFrame((frame) => frame.includes("· default"))
    expect(view.ctx().local.model.variant.current()).toBeUndefined()
    await view.click("default", MouseButton.RIGHT)
    await view.waitForFrame((frame) => frame.includes("· low"))
    expect(view.ctx().local.model.variant.current()).toBe("low")
    await view.click("low", MouseButton.RIGHT)
    await view.waitForFrame((frame) => frame.includes("· high"))
    await view.click("high", MouseButton.RIGHT)
    await view.waitForFrame((frame) => frame.includes("· default"))
    expect(view.ctx().local.model.variant.current()).toBeUndefined()
    expect(view.ctx().dialog.stack.length).toBe(0)
  })
}

test("chat session displays default variant for a model with no variants", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path, "metadata-session", false)
  const frame = await view.waitForFrame((frame) => frame.includes("Metadata Model") && frame.includes("· default"))
  expect(frame).toContain("· default")
  expect(view.ctx().local.model.variant.list()).toEqual([])
  await view.click("default")
  await view.click("default", MouseButton.RIGHT)
  expect(view.ctx().local.model.variant.current()).toBeUndefined()
  expect(view.ctx().dialog.stack.length).toBe(0)
})

for (const sessionID of [undefined, "metadata-session"]) {
  test(`reminder counter stays in the prompt controls on ${sessionID ? "chat session" : "home"}`, async () => {
    await using tmp = await tmpdir()
    using view = await mount(tmp.path, sessionID)
    const empty = await view.waitForFrame((frame) => frame.includes("Metadata Model") && frame.includes("◷ (0)"))
    const lines = empty.split("\n")
    const row = lines.findIndex((line) => line.includes("◷ (0)"))
    expect(lines[row]).toContain("default")
    expect(lines[row].indexOf("◷")).toBeGreaterThan(lines[row].indexOf("default"))
    expect(lines[row].indexOf("◷")).toBeGreaterThan(80)
    expect(lines.slice(0, row).some((line) => line.includes("◷"))).toBe(false)
    await view.click("◷ (0)")
    await view.waitForFrame((frame) => frame.includes("Reminders · all terminals"))
    view.ctx().dialog.clear()
    const store = NativeReminders.open(`${tmp.path}/reminders.sqlite3`)
    try {
      const reminder = store.create(store.parse("in 20 minutes check CI"))
      await view.waitForFrame((frame) => frame.includes("◷ (1)"))
      await view.click("◷ (1)")
      await view.waitForFrame((frame) => frame.includes("check CI"))
      view.ctx().dialog.clear()
      store.complete(reminder.id)
      await view.waitForFrame((frame) => frame.includes("◷ (0)"))
    } finally {
      store.close()
    }
  })
}

test("submitting reminder slash commands keeps their dialog open and clears the prompt", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path)
  await view.waitForFrame((frame) => frame.includes("Metadata Model") && frame.includes("◷ (0)"))
  for (const command of ["/remind in 20 minutes check CI", "/reminders ", "/notifications "]) {
    view.prompt().set({ input: command, parts: [] })
    view.app.mockInput.pressEnter()
    await view.waitForFrame((frame) =>
      frame.includes(command.startsWith("/remind ") ? "Confirm reminder" : "Reminders · all terminals"),
    )
    expect(view.prompt().current.input).toBe("")
    view.ctx().dialog.clear()
    const frame = await view.waitForFrame(
      (frame) =>
        frame.includes("Metadata Model") && !frame.includes("all terminals") && !frame.includes("Confirm reminder"),
    )
    expect(frame).not.toContain(command.trim())
  }
})

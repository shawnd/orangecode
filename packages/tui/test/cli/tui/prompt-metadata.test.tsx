/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { MouseButton, TextareaRenderable, type Renderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, onCleanup, Show } from "solid-js"
import { Shell } from "../../../src/routes/shell"
import { Prompt, type PromptRef } from "../../../src/component/prompt"
import { FrecencyProvider } from "../../../src/component/prompt/frecency"
import { DialogModel } from "../../../src/component/dialog-model"
import { DialogProvider } from "../../../src/component/dialog-provider"
import { DialogVariant } from "../../../src/component/dialog-variant"
import { TuiConfigProvider, useTuiConfig } from "../../../src/config"
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
import {
  OPENCODE_BASE_MODE,
  OpencodeKeymapProvider,
  registerOpencodeKeymap,
  useBindings,
  useOpencodeKeymap,
} from "../../../src/keymap"
import { PromptHistoryProvider, usePromptHistory } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { useDialog } from "../../../src/ui/dialog"
import { ToastProvider, useToast } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { compactedSession } from "../../fixture/compacted-session"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createFetch, createEventSource, directory, json, worktree } from "../../fixture/tui-sdk"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { startupPresentation } from "../../../src/startup/presentation"
import { RemindersProvider } from "../../../src/context/reminders"
import { NativeReminders } from "@opencode-ai/core/native/reminders"
import { TuiStartupProvider, type EarlyInput } from "../../../src/context/runtime"
import { useStartupModelDialog } from "../../../src/component/startup-model-dialog"
import type { StartupSlashDraft } from "../../../src/startup/slashes"
import { chmod } from "node:fs/promises"
import { annotationPrompt } from "../../../src/feature-plugins/system/diff-viewer-review"

async function mount(
  root: string,
  sessionID?: string,
  variants = true,
  startup?: { input: EarlyInput; load: Promise<void> },
  submission?: { abort: Promise<Response> },
  options: { submitKey?: string } = {},
) {
  const [activeSession, setSession] = createSignal(sessionID)
  const events = createEventSource()
  const aborted: string[] = []
  const submitted: { path: string; body?: unknown }[] = []
  const cleanup: Promise<void>[] = []
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
  const calls = createFetch(async (url, request) => {
    if (request?.method === "POST" && url.pathname.startsWith("/session/")) {
      submitted.push({ path: url.pathname, body: request.body ? await request.clone().json() : undefined })
    }
    if (url.pathname.endsWith("/abort")) {
      aborted.push(url.pathname)
      return submission?.abort ?? json(true)
    }
    if (url.pathname === "/config") return json({ model: "metadata-provider/metadata-model" })
    if (url.pathname === "/config/providers")
      return startup
        ? startup.load.then(() =>
            json({ providers: [provider, other], default: { "metadata-provider": "metadata-model" } }),
          )
        : json({ providers: [provider, other], default: { "metadata-provider": "metadata-model" } })
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
        sync: ReturnType<typeof useSync>
        history: ReturnType<typeof usePromptHistory>
        kv: ReturnType<typeof useKV>
        toast: ReturnType<typeof useToast>
        keymap: ReturnType<typeof useOpencodeKeymap>
      }
    | undefined
  let prompt: PromptRef | undefined
  function Controls() {
    const local = useLocal()
    const dialog = useDialog()
    const sync = useSync()
    const route = useRoute()
    const tuiConfig = useTuiConfig()
    context = {
      local,
      dialog,
      route,
      sync,
      history: usePromptHistory(),
      kv: useKV(),
      toast: useToast(),
      keymap: useOpencodeKeymap(),
    }
    useStartupModelDialog()
    useBindings(() => ({
      mode: OPENCODE_BASE_MODE,
      bindings: tuiConfig.keybinds.gather("test.app", ["agent.cycle", "agent.cycle.reverse"]),
    }))
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
        { name: "agent.cycle.reverse", run: () => local.agent.move(-1) },
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
      <Show
        when={route.data.type === "session" && route.data.shell}
        fallback={
          <box paddingTop={10}>
            <Prompt
              sessionID={activeSession()}
              visible={sync.ready}
              ref={(ref) => {
                prompt = ref
              }}
            />
          </box>
        }
      >
        <Shell />
      </Show>
    )
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({
      theme: "opencode",
      ...(options.submitKey ? { keybinds: { prompt_submit: options.submitKey } } : {}),
    })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts
        directory={directory}
        paths={{ state: root, home: root, worktree }}
        onDispose={(done) => cleanup.push(done)}
      >
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
                            <TuiStartupProvider value={{ skipInitialLoading: false, earlyInput: startup?.input }}>
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
                                                      <TuiStartupProvider
                                                        value={{
                                                          skipInitialLoading: false,
                                                          earlyInput: startup?.input,
                                                        }}
                                                      >
                                                        <Controls />
                                                      </TuiStartupProvider>
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
                            </TuiStartupProvider>
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
  const app = await testRender(() => <Harness />, { width: 120, height: 30, kittyKeyboard: true })
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
    submitted,
    setSession,
    sessionRequests: calls.session,
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
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      await Promise.all(cleanup)
    },
  }
}

test("submitting compact annotations sends expanded review text and preserves attachments", async () => {
  await using tmp = await tmpdir()
  await using view = await mount(tmp.path, "parent")
  await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  view.prompt().set(
    annotationPrompt(
      [
        {
          id: "a",
          file: "review.ts",
          source: "working tree",
          hunk: "@@ -1 +1 @@",
          side: "new",
          start: 1,
          end: 1,
          preview: "changed",
          comment: "Preserve the behavior",
        },
      ],
      {
        input: "Review [Image 1]",
        parts: [
          {
            type: "file",
            mime: "image/png",
            url: "data:image/png;base64,aW1hZ2U=",
            source: { type: "file", path: "image.png", text: { value: "[Image 1]", start: 7, end: 16 } },
          },
        ],
      },
    ),
  )
  await view.waitForFrame((frame) => frame.includes("Diff annotations · edit"))
  view.app.mockInput.pressEnter()
  await view.waitForFrame(() => view.submitted.length === 1 && view.prompt().current.input === "")
  expect(view.submitted[0]).toMatchObject({
    path: "/session/parent/message",
    body: {
      parts: [
        {
          type: "text",
          text: "Review [Image 1]\n\nPlease address these diff review annotations:\n\n1. review.ts:1 (new, working tree)\nComment: Preserve the behavior\nSelected code:\n    changed",
        },
        { type: "file", mime: "image/png", url: "data:image/png;base64,aW1hZ2U=" },
      ],
    },
  })
})

test("prompt context meter restores pre-compaction usage on undo and compacted usage on redo", async () => {
  await using tmp = await tmpdir()
  await using view = await mount(tmp.path, "parent")
  await view.waitForFrame((frame) => frame.includes("Perms"))
  const fixture = compactedSession()
  view.ctx().sync.set("session", [fixture.session])
  view.ctx().sync.set("message", "parent", fixture.messages)
  view.ctx().sync.set("part", fixture.parts)
  await view.waitForFrame((frame) => frame.includes("12.0K (12%)"))
  view.ctx().sync.set("session", [{ ...fixture.session, revert: { messageID: "msg_a-compact" } }])
  const restored = await view.waitForFrame((frame) => frame.includes("90.0K (90%)"))
  expect(restored).not.toContain("12.0K (12%)")
  view.ctx().sync.set("session", [fixture.session])
  const redone = await view.waitForFrame((frame) => frame.includes("12.0K (12%)"))
  expect(redone).not.toContain("90.0K (90%)")
})

test("session changes precede the branch on the interrupt row without adding a footer row", async () => {
  await using tmp = await tmpdir()
  await using view = await mount(tmp.path, "parent")
  await view.waitForFrame((frame) => frame.includes("Perms"))
  view.events.emit({
    directory,
    payload: {
      id: "session-counts",
      type: "session.updated",
      properties: {
        sessionID: "parent",
        info: {
          id: "parent",
          slug: "parent",
          projectID: "project",
          directory,
          title: "Parent",
          version: "test",
          time: { created: 1, updated: 2 },
          summary: { additions: 3, deletions: 1, files: 1 },
        },
      },
    },
  })
  const idle = await view.waitForFrame((frame) => frame.includes("+3-1 ·  main"))
  const lines = idle.split("\n")
  const row = lines.findIndex((line) => line.includes("+3-1"))
  expect(lines[row - 1]).toContain("Perms")
  expect(lines[row]).toContain("+3-1 ·  main")
  view.events.emit({
    directory,
    payload: {
      id: "busy-counts",
      type: "session.status",
      properties: { sessionID: "parent", status: { type: "busy" } },
    },
  })
  const busy = await view.waitForFrame((frame) => frame.includes("esc interrupt"))
  expect(busy.split("\n")[row]).toContain("esc interrupt")
  expect(busy.split("\n")[row]).toContain("+3-1 ·  main")
  expect(busy.split("\n").filter((line) => line.trim())).toHaveLength(lines.filter((line) => line.trim()).length)
})

test("Ctrl+Enter waits for interruption before sending the draft and attachments once", async () => {
  await using tmp = await tmpdir()
  const gate = Promise.withResolvers<Response>()
  await using view = await mount(tmp.path, "parent", true, undefined, { abort: gate.promise })
  await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  view.events.emit({
    directory,
    payload: { id: "busy", type: "session.status", properties: { sessionID: "parent", status: { type: "busy" } } },
  })
  view.prompt().set({
    input: "Use this new context [Image 1]",
    parts: [
      {
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,aGVsbG8=",
        source: { type: "file", path: "image.png", text: { value: "[Image 1]", start: 21, end: 30 } },
      },
    ],
  })
  await view.waitForFrame((frame) => frame.includes("send now"))
  view.app.mockInput.pressKey("RETURN", { ctrl: true })
  await view.waitForFrame(() => view.aborted.length === 1)
  view.app.mockInput.pressKey("RETURN", { ctrl: true })
  await view.app.renderOnce()
  expect(view.submitted.map((call) => call.path)).toEqual(["/session/parent/abort"])
  expect(view.prompt().current.input).toBe("Use this new context [Image 1]")
  gate.resolve(json(true))
  await view.waitForFrame(() => view.submitted.length === 2 && view.prompt().current.input === "")
  expect(view.submitted[1]).toMatchObject({
    path: "/session/parent/message",
    body: {
      parts: [
        { type: "text", text: "Use this new context [Image 1]" },
        { type: "file", mime: "image/png" },
      ],
    },
  })
})

test("Ctrl+Enter with an empty draft resumes pending messages without adding a message", async () => {
  await using tmp = await tmpdir()
  await using view = await mount(tmp.path, "parent")
  await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  view.events.emit({
    directory,
    payload: {
      id: "pending-user",
      type: "message.updated",
      properties: {
        sessionID: "parent",
        info: {
          id: "msg_pending",
          sessionID: "parent",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "metadata-provider", modelID: "metadata-model" },
        },
      },
    },
  })
  view.events.emit({
    directory,
    payload: { id: "busy", type: "session.status", properties: { sessionID: "parent", status: { type: "busy" } } },
  })
  await view.waitForFrame((frame) => frame.includes("send now"))
  view.app.mockInput.pressKey("RETURN", { ctrl: true })
  await view.waitForFrame(() => view.submitted.length === 2)
  expect(view.submitted.map((call) => call.path)).toEqual(["/session/parent/abort", "/session/parent/resume"])
  expect(view.prompt().current.input).toBe("")
})

test("send now keeps the draft when interruption fails", async () => {
  await using tmp = await tmpdir()
  await using view = await mount(tmp.path, "parent", true, undefined, {
    abort: Promise.resolve(json({}, { status: 500 })),
  })
  await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  view.events.emit({
    directory,
    payload: { id: "busy", type: "session.status", properties: { sessionID: "parent", status: { type: "busy" } } },
  })
  view.prompt().set({ input: "Keep this correction", parts: [] })
  await view.waitForFrame((frame) => frame.includes("send now"))
  view.app.mockInput.pressKey("RETURN", { ctrl: true })
  await view.waitForFrame(() => view.ctx().toast.currentToast?.title === "Failed to interrupt session")
  expect(view.prompt().current.input).toBe("Keep this correction")
  expect(view.submitted.map((call) => call.path)).toEqual(["/session/parent/abort"])
})

test("Enter submits normally and Shift+Enter still inserts a newline", async () => {
  await using tmp = await tmpdir()
  await using view = await mount(tmp.path, "parent")
  await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  view.prompt().set({ input: "Normal input", parts: [] })
  view.app.mockInput.pressKey("RETURN", { shift: true })
  await view.waitForFrame(() => view.prompt().current.input.includes("\n"))
  expect(view.submitted).toHaveLength(0)
  view.app.mockInput.pressEnter()
  await view.waitForFrame(() => view.submitted.length === 1)
  expect(view.submitted[0]?.path).toBe("/session/parent/message")
  expect(view.aborted).toHaveLength(0)
})

test("the real model picker opens from fast input before provider discovery resolves", async () => {
  await using tmp = await tmpdir()
  const gate = Promise.withResolvers<void>()
  const presentation = startupPresentation()
  presentation.selection = {
    directory,
    agent: "Build",
    agentID: "build",
    providerID: "metadata-provider",
    modelID: "metadata-model",
    model: "Metadata Model",
    provider: "Metadata Provider",
    variant: "default",
  }
  presentation.controls = {
    directory,
    providerID: "metadata-provider",
    models: [
      { id: "metadata-model", name: "Metadata Model", variants: ["high", "low"] },
      { id: "second-model", name: "second Model", variants: ["high", "low"] },
    ],
    agents: [],
  }
  let draft: StartupSlashDraft = {
    text: "/models ",
    cursor: 8,
    command: { name: "model.list", display: "/models", prefix: "/models " },
  }
  let modal = false
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  const input: EarlyInput = {
    active: true,
    get modal() {
      return modal
    },
    presentation,
    read: () => ({ ...draft }),
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    openModal() {
      draft = { text: "", cursor: 0 }
      modal = true
      notify()
    },
    closeModal() {
      modal = false
      notify()
    },
    selectModel(providerID, modelID) {
      draft = { ...draft, changes: [{ target: "select-model", providerID, modelID }] }
      notify()
    },
    takeover: async () => process.stdin,
    onCancel() {},
    claim: () => undefined,
    dispose() {},
  }
  using view = await mount(tmp.path, undefined, true, { input, load: gate.promise })
  await view.waitForFrame((frame) => frame.includes("Select model") && frame.includes("second Model"))
  expect(view.ctx().sync.ready).toBe(false)
  expect(modal).toBe(true)
  view.app.mockInput.pressArrow("down")
  await view.app.renderOnce()
  view.app.mockInput.pressEnter()
  const selected = Date.now() + 2000
  while (!draft.changes && Date.now() < selected) {
    await view.app.renderOnce()
    await Bun.sleep(10)
  }
  expect(draft.changes).toEqual([{ target: "select-model", providerID: "metadata-provider", modelID: "second-model" }])
  expect(modal).toBe(false)
  gate.resolve()
  await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  const ready = Date.now() + 2000
  while (!view.ctx().local.model.ready && Date.now() < ready) await Bun.sleep(10)
  view.prompt().adoptStartupDraft?.(draft)
  await view.waitForFrame((frame) => frame.includes("Select variant"))
  expect(view.ctx().local.model.current()).toEqual({ providerID: "metadata-provider", modelID: "second-model" })
  const saved = Date.now() + 2000
  while (Date.now() < saved) {
    if (
      (await Bun.file(`${tmp.path}/model.json`).exists()) &&
      (await Bun.file(`${tmp.path}/model.json`).json()).recent?.[0]?.modelID === "second-model"
    )
      break
    await Bun.sleep(10)
  }
  view.ctx().dialog.clear()
  view.prompt().reset()
})

test("fast mouse cycling is replayed through the same live model and variant handlers", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path)
  await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  view.prompt().adoptStartupDraft?.({
    text: "keep typing",
    cursor: 11,
    changes: [
      { target: "model", direction: 1 },
      { target: "variant", direction: -1 },
    ],
  })
  await view.waitForFrame((frame) => frame.includes("second Model") && frame.includes("· low"))
  expect(view.ctx().local.model.current()).toEqual({ providerID: "metadata-provider", modelID: "second-model" })
  expect(view.ctx().local.model.variant.current()).toBe("low")
  expect(view.prompt().current.input).toBe("keep typing")
  const saved = Date.now() + 2000
  while (Date.now() < saved) {
    if (
      (await Bun.file(`${tmp.path}/model.json`).exists()) &&
      (await Bun.file(`${tmp.path}/model.json`).json()).variant?.["metadata-provider/second-model"] === "low"
    )
      break
    await Bun.sleep(10)
  }
  const requests = view.sessionRequests.length
  view.prompt().reset()
  view.prompt().adoptStartupDraft?.({
    text: "do not send",
    cursor: 11,
    submit: true,
    changes: [{ target: "select-model", providerID: "missing", modelID: "missing" }],
  })
  await view.app.renderOnce()
  expect(view.sessionRequests.length).toBe(requests)
  expect(view.prompt().current.input).toBe("do not send")
  view.prompt().reset()
})

function runningTask(view: Awaited<ReturnType<typeof mount>>, child = "child") {
  view.events.emit({
    directory,
    payload: {
      id: `busy-${child}`,
      type: "session.status",
      properties: { sessionID: child, status: { type: "busy" } },
    },
  })
  const part: ToolPart = {
    id: `task-part-${child}`,
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
      metadata: { sessionId: child, background: true },
      time: { start: 1, end: 2 },
    },
  }
  view.events.emit({
    directory,
    payload: {
      id: `task-started-${child}`,
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
  const idle = await view.waitForFrame((frame) => !frame.includes("background agent"))
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
  expect(lines.filter((line) => line.trim())).toHaveLength(idle.split("\n").filter((line) => line.trim()).length)
  expect(lines[progressRow]).toContain("esc interrupt")
  expect(lines[progressRow]).toContain(" main")
  expect(working).not.toContain("interrupt all")
})

test("a lone background agent opens directly by click or Down/Enter", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path, "parent")
  await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  runningTask(view)
  await view.click("1 background agent")
  await view.waitForFrame(() => view.ctx().route.data.type === "session")
  expect(view.ctx().route.data).toMatchObject({ type: "session", sessionID: "child" })
  expect(view.ctx().dialog.stack).toHaveLength(0)
  view.ctx().route.navigate({ type: "session", sessionID: "parent" })
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
  await view.waitForFrame(() => {
    const route = view.ctx().route.data
    return route.type === "session" && route.sessionID === "child"
  })
  expect(view.ctx().route.data).toMatchObject({ type: "session", sessionID: "child" })
  expect(view.ctx().dialog.stack).toHaveLength(0)
})

test("background agent activity keeps animating before Escape while the parent is idle", async () => {
  await using tmp = await tmpdir()
  await using view = await mount(tmp.path, "parent")
  const idle = await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  view.ctx().kv.set("animations_enabled", true)
  runningTask(view)
  const beforeEscape = (frame: string) => {
    const line = frame.split("\n").find((line) => line.includes("esc interrupt")) ?? ""
    return line.match(/[■⬝]{8}/)?.[0] ?? ""
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
  const lines = first.split("\n")
  expect(lines[lines.findIndex((line) => line.includes(directory)) + 1]).toContain(beforeEscape(first))
  expect(lines.find((line) => line.includes("esc interrupt"))).toContain(" main")
  expect(first.split("\n").filter((line) => line.trim())).toHaveLength(
    idle.split("\n").filter((line) => line.trim()).length,
  )
  expect(beforeEscape(next)).not.toBe(beforeEscape(first))
  view.app.resize(80, 30)
  const narrow = await view.waitForFrame((frame) => beforeEscape(frame).length > 0)
  const rows = narrow.split("\n")
  expect(rows[rows.findIndex((line) => line.includes(directory)) + 1]).toMatch(/[■⬝]{8} esc interrupt.* main/)
  view.events.emit({
    directory,
    payload: { id: "agent-idle", type: "session.status", properties: { sessionID: "child", status: { type: "idle" } } },
  })
  await view.waitForFrame((frame) => !frame.includes("background agent") && !frame.includes("esc interrupt"))
})

test("multiple running agents keep the picker and navigate to the selected agent", async () => {
  await using tmp = await tmpdir()
  await using view = await mount(tmp.path, "parent")
  await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  runningTask(view)
  runningTask(view, "other-child")
  await view.click("2 background agents")
  await view.waitForFrame((frame) => frame.includes("Background agents") && frame.includes("Inspect cache"))
  expect(view.ctx().route.data).toEqual({ type: "home" })
  view.app.mockInput.pressArrow("down")
  await view.app.renderOnce()
  view.app.mockInput.pressEnter()
  await view.waitForFrame(() => view.ctx().dialog.stack.length === 0)
  expect(view.ctx().route.data).toEqual({ type: "session", sessionID: "other-child" })
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
  await view.waitForFrame(() => {
    const route = view.ctx().route.data
    return route.type === "session" && route.sessionID === "child"
  })
  expect(view.ctx().dialog.stack).toHaveLength(0)
  view.ctx().route.navigate({ type: "session", sessionID: "parent" })
  await view.app.renderOnce()
  view.app.mockInput.pressArrow("up")
  await view.waitForFrame(() => view.prompt().current.input === "newer prompt")
  view.prompt().set({ input: "edited recalled prompt", parts: [] })
  await view.app.renderOnce()
  view.app.mockInput.pressArrow("down")
  await view.app.renderOnce()
  view.app.mockInput.pressEnter()
  await view.waitForFrame(() => {
    const route = view.ctx().route.data
    return route.type === "session" && route.sessionID === "child"
  })
  expect(view.prompt().current.input).toBe("edited recalled prompt")
  expect(view.ctx().dialog.stack).toHaveLength(0)
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
    expect(lines[shellRow]).toContain(" main")
    expect(lines[shellRow].indexOf("[⋯]")).toBeLessThan(lines[shellRow].indexOf("esc interrupt"))
  }
  await view.click("1 shell")
  await view.waitForFrame((frame) => frame.includes("Starting tests") && frame.includes("bun test"))
  expect(view.ctx().dialog.stack).toHaveLength(0)
  expect(view.ctx().route.data).toMatchObject({
    type: "session",
    sessionID: "child",
    shell: { messageID: "child-message", partID: "shell-part", returnSessionID: "parent" },
  })
  view.app.mockInput.pressArrow("up")
  await view.waitForFrame((frame) => frame.includes("1 shell"))
  expect(view.ctx().route.data).toEqual({ type: "session", sessionID: "parent" })
  view.prompt().set({ input: "keep this draft", parts: [] })
  await view.app.renderOnce()
  view.app.mockInput.pressArrow("down")
  await view.app.renderOnce()
  view.app.mockInput.pressArrow("down")
  await view.app.renderOnce()
  view.app.mockInput.pressArrow("up")
  await view.app.renderOnce()
  view.app.mockInput.pressEnter()
  await view.waitForFrame(() => {
    const route = view.ctx().route.data
    return route.type === "session" && route.sessionID === "child"
  })
  expect(view.ctx().dialog.stack).toHaveLength(0)
  view.ctx().route.navigate({ type: "session", sessionID: "parent" })
  await view.app.renderOnce()
  view.app.mockInput.pressArrow("down")
  await view.app.renderOnce()
  view.app.mockInput.pressArrow("down")
  await view.app.renderOnce()
  view.app.mockInput.pressArrow("down")
  await view.app.renderOnce()
  view.app.mockInput.pressEnter()
  await view.waitForFrame((frame) => frame.includes("Starting tests"))
  expect(view.ctx().dialog.stack).toHaveLength(0)
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
  view.app.mockInput.pressEscape()
  await view.waitForFrame((frame) => frame.includes("Metadata Model") && !frame.includes("1 shell"))
  expect(view.prompt().current.input).toBe("keep this draft")
  view.prompt().reset()
})

test("multiple running shells keep the picker and open the selected command full-screen", async () => {
  await using tmp = await tmpdir()
  await using view = await mount(tmp.path, "parent")
  await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  for (const command of ["first", "second"]) {
    const part: ToolPart = {
      id: command,
      sessionID: "parent",
      messageID: "shell-message",
      callID: command,
      type: "tool",
      tool: "bash",
      state: {
        status: "completed",
        input: { command },
        title: command,
        output: "Job started",
        time: { start: 1, end: 2 },
        metadata: { background: true, shellStatus: "running", output: `${command} output` },
      },
    }
    view.events.emit({
      directory,
      payload: {
        id: `started-${command}`,
        type: "message.part.updated",
        properties: { sessionID: part.sessionID, part, time: 3 },
      },
    })
  }
  await view.click("2 shells")
  await view.waitForFrame((frame) => frame.includes("Running shells") && frame.includes("second"))
  view.app.mockInput.pressArrow("down")
  await view.app.renderOnce()
  view.app.mockInput.pressEnter()
  await view.waitForFrame((frame) => frame.includes("second output"))
  expect(view.ctx().dialog.stack).toHaveLength(0)
  view.app.mockInput.pressEnter()
  await view.waitForFrame((frame) => frame.includes("2 shells"))
  expect(view.ctx().route.data).toEqual({ type: "session", sessionID: "parent" })
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
        output: Array.from(
          { length: 80 },
          (_, index) => `Building module ${String(index).padStart(2, "0")} ${"x".repeat(95)}`,
        ).join("\n"),
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
  const frame = await view.waitForFrame((frame) => frame.includes("Building module 79"))
  expect(view.ctx().dialog.stack).toHaveLength(0)
  expect(frame).toContain("Shell · running")
  expect(frame).toContain("stdin open")
  expect(frame).toContain("/tmp/build.log")
  expect(frame).toContain("x".repeat(95))
  expect(frame).not.toContain("Building module 00")
  const first = frame.match(/Building module (\d+)/)?.[1]
  view.app.mockInput.pressArrow("left")
  const scrolled = await view.waitForFrame((frame) => frame.match(/Building module (\d+)/)?.[1] !== first)
  expect(view.ctx().route.data.type).toBe("session")
  view.app.mockInput.pressArrow("right")
  await view.waitForFrame((frame) => frame.match(/Building module (\d+)/)?.[1] === first)
  view.app.mockInput.pressKey("HOME")
  await view.waitForFrame((frame) => frame.includes("Building module 00"))
  expect(scrolled).not.toContain("Metadata Model")
  if (part.state.status !== "completed") throw new Error("Expected completed source call")
  view.events.emit({
    directory,
    payload: {
      id: "bg-shell-output",
      type: "message.part.updated",
      properties: {
        sessionID: part.sessionID,
        time: 4,
        part: {
          ...part,
          state: {
            ...part.state,
            metadata: { ...part.state.metadata, output: `${part.state.metadata.output}\nBuilding module 80` },
          },
        },
      },
    },
  })
  await view.waitForFrame(() => {
    const value = view.ctx().sync.data.part[part.messageID]?.find((item) => item.id === part.id)
    return (
      value?.type === "tool" &&
      "metadata" in value.state &&
      String(value.state.metadata?.output).includes("Building module 80")
    )
  })
  const paused = await view.waitForFrame((frame) => frame.includes("Building module 00"))
  expect(paused).not.toContain("Building module 80")
  view.app.mockInput.pressKey("END")
  await view.waitForFrame((frame) => frame.includes("Building module 80"))
  view.app.mockInput.pressArrow("up", { ctrl: true })
  await view.waitForFrame((frame) => frame.includes("1 shell"))
  expect(view.ctx().route.data).toEqual({ type: "session", sessionID: "parent" })
  await view.click("1 shell")
  await view.waitForFrame((frame) => frame.includes("Building module 80"))
  view.app.mockInput.pressEscape()
  await view.waitForFrame((frame) => frame.includes("1 shell") && !frame.includes("Building module"))
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

test("startup slash selection opens the live picker, while stale actions remain editable", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path)
  await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  view.prompt().adoptStartupDraft?.({
    text: "/models ",
    cursor: 8,
    command: { name: "model.list", display: "/models", prefix: "/models " },
  })
  await view.waitForFrame((frame) => frame.includes("Select model"))
  expect(view.prompt().current.input).toBe("")
  view.ctx().dialog.clear()
  view.prompt().adoptStartupDraft?.({
    text: "/removed ",
    cursor: 9,
    command: { name: "missing.command", display: "/removed", prefix: "/removed " },
  })
  await view.app.renderOnce()
  expect(view.prompt().current.input).toBe("/removed ")
  expect(view.ctx().dialog.stack.length).toBe(0)
  view.prompt().reset()
})

test("an unfinished startup slash keeps its popup and selected item after adoption", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path)
  await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  view.prompt().adoptStartupDraft?.({ text: "/", cursor: 1, slash: { query: "", selected: "/models" } })
  await view.waitForFrame((frame) => frame.includes("/models") && frame.includes("/agents"))
  expect(view.prompt().current.input).toBe("/")
  view.app.mockInput.pressEnter()
  await view.waitForFrame((frame) => frame.includes("Select model"))
  expect(view.ctx().local.agent.current()?.name).toBe("build")
  view.ctx().dialog.clear()
  view.prompt().reset()
})

test("home selection changes update the read-only startup snapshot without persisting a draft", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path)
  await view.waitForFrame((frame) => frame.includes("Metadata Model") && frame.includes("default"))
  await view.click("Build")
  await view.waitForFrame((frame) => frame.includes("Terminal"))
  await view.click("Terminal")
  await view.waitForFrame((frame) => frame.includes("Plan"))
  view.ctx().local.model.variant.set("high")
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (await Bun.file(`${tmp.path}/startup-presentation.json`).exists()) {
      const cached = startupPresentation(await Bun.file(`${tmp.path}/startup-presentation.json`).json())
      if (cached.selection?.agent === "Plan" && cached.selection.variant === "high") break
    }
    await Bun.sleep(10)
  }
  expect(startupPresentation(await Bun.file(`${tmp.path}/startup-presentation.json`).json()).selection).toMatchObject({
    directory,
    agent: "Plan",
    model: "Metadata Model",
    provider: "Metadata Provider",
    variant: "high",
  })
  const selection = startupPresentation(await Bun.file(`${tmp.path}/startup-presentation.json`).json()).selection
  expect(selection?.agentColor).toBe("#9d7cd8")
  expect(selection?.variantColor).toBe("#f5a742")
  expect(Object.keys(await Bun.file(`${tmp.path}/startup-presentation.json`).json())).not.toContain("draft")
})

for (const sessionID of [undefined, "metadata-session"]) {
  test(`prompt metadata controls work on ${sessionID ? "chat session" : "home"}`, async () => {
    await using tmp = await tmpdir()
    using view = await mount(tmp.path, sessionID)
    const frame = await view.waitForFrame((frame) => frame.includes("Metadata Model") && frame.includes("default"))
    expect(frame).toContain("Build")

    await view.click("Build")
    const terminal = await view.waitForFrame((frame) => frame.includes("Terminal"))
    expect(terminal).not.toContain("Metadata Model")
    await view.click("Terminal")
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

test("Tab cycles terminal, plan, and build, and terminal commands remain in shell mode", async () => {
  await using tmp = await tmpdir()
  await using view = await mount(tmp.path, "metadata-session")
  await view.waitForFrame((frame) => frame.includes("Build") && frame.includes("Metadata Model"))
  view.app.mockInput.pressKey("TAB")
  const terminal = await view.waitForFrame((frame) => frame.includes("Terminal"))
  expect(terminal).not.toContain("Metadata Model")
  expect(terminal).toContain("tab modes")

  for (const command of ["ls -la", "/bin/pwd", "exit"]) {
    view.prompt().set({ input: command, parts: [] })
    await view.app.renderOnce()
    view.app.mockInput.pressEnter()
    await view.waitForFrame(() => view.submitted.length === ["ls -la", "/bin/pwd", "exit"].indexOf(command) + 1)
    expect(view.submitted.at(-1)).toMatchObject({
      path: "/session/metadata-session/shell",
      body: { command, agent: "build" },
    })
    expect(view.ctx().local.prompt.mode()).toBe("shell")
    expect(view.prompt().current.input).toBe("")
  }

  // Session hydration must not exit terminal mode after its first command.
  view.ctx().sync.set("message", "metadata-session", [
    {
      id: "terminal-message",
      sessionID: "metadata-session",
      role: "user",
      agent: "build",
      model: { providerID: "metadata-provider", modelID: "metadata-model" },
      time: { created: 1 },
    },
  ])
  await view.app.renderOnce()
  expect(view.ctx().local.prompt.mode()).toBe("shell")

  view.app.mockInput.pressKey("TAB")
  await view.waitForFrame((frame) => frame.includes("Plan") && frame.includes("Metadata Model"))
  view.app.mockInput.pressKey("TAB")
  await view.waitForFrame((frame) => frame.includes("Build"))
  view.app.mockInput.pressKey("TAB", { shift: true })
  await view.waitForFrame((frame) => frame.includes("Plan"))
  view.app.mockInput.pressKey("TAB", { shift: true })
  await view.waitForFrame((frame) => frame.includes("Terminal"))
  view.app.mockInput.pressKey("TAB", { shift: true })
  await view.waitForFrame((frame) => frame.includes("Build"))
})

async function herdrFixture(root: string, delayed = false) {
  const env = { PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV }
  if (delayed) await Bun.write(`${root}/hold`, "1")
  await Bun.write(
    `${root}/herdr`,
    `#!${process.execPath}
import { appendFileSync } from "node:fs"
const root = import.meta.dir
appendFileSync(root + "/started", "started\\n")
if (await Bun.file(root + "/hold").exists()) {
  while (!await Bun.file(root + "/release").exists()) await Bun.sleep(5)
}

const pane = { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "opencode", agent_status: "working", terminal_title_stripped: "OC | Test task", cwd: "/test/repo", agent_session: { agent: "opencode", kind: "id", value: "metadata-session" } }
const args = process.argv.slice(2)
const result = args[1] === "current" ? { pane } : args[0] === "pane" ? { panes: [pane] } : args[0] === "tab" ? { tabs: [{ tab_id: "w1:t1", label: "Test tab" }] } : { workspaces: [{ workspace_id: "w1", label: "Test workspace" }] }
console.log(JSON.stringify({ result }))
appendFileSync(root + "/completed", "completed\\n")
`,
  )
  await chmod(`${root}/herdr`, 0o755)
  process.env.PATH = `${root}:${env.PATH}`
  process.env.HERDR_ENV = "1"
  return {
    async wait(state: "started" | "completed") {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (
          (
            await Bun.file(`${root}/${state}`)
              .text()
              .catch(() => "")
          )
            .trim()
            .split("\n").length === 4
        )
          return
        await Bun.sleep(5)
      }
      throw new Error(`Herdr fixture did not reach ${state}`)
    },
    release: () => Bun.write(`${root}/release`, "1"),
    async [Symbol.asyncDispose]() {
      await Bun.write(`${root}/release`, "1")
      if (await Bun.file(`${root}/started`).exists()) await this.wait("completed")
      Object.entries(env).forEach(([key, value]) => {
        if (value === undefined) {
          delete process.env[key]
          return
        }
        process.env[key] = value
      })
    },
  }
}

function textarea(item: Renderable, text: string): TextareaRenderable | undefined {
  if (item instanceof TextareaRenderable && item.plainText === text) return item
  return item
    .getChildren()
    .map((child) => textarea(child, text))
    .find((input) => input !== undefined)
}

for (const binding of ["send now", "rebound submit"]) {
  test(`bare /herdr keeps its scope picker open through ${binding}`, async () => {
    await using tmp = await tmpdir()
    await using fixture = await herdrFixture(tmp.path)
    await using view = await mount(
      tmp.path,
      "metadata-session",
      true,
      undefined,
      undefined,
      binding === "rebound submit" ? { submitKey: "ctrl+y" } : {},
    )
    await view.waitForFrame((frame) => frame.includes("Metadata Model"))
    view.prompt().set({ input: "/herdr ", parts: [] })
    view.app.mockInput.pressKey(binding === "send now" ? "RETURN" : "y", { ctrl: true })
    await view.waitForFrame((frame) => frame.includes("Gather Herdr sessions"))
    await view.app.renderOnce()
    expect(view.ctx().dialog.stack).toHaveLength(1)
    expect(view.submitted).toHaveLength(0)
    view.app.mockInput.pressEnter()
    await view.waitForFrame((frame) => frame.includes("[Herdr workspace: 1 OpenCode panes]"))
    expect(view.prompt().current.parts).toHaveLength(1)
    expect(view.submitted).toHaveLength(0)
  })
}

for (const change of ["reset", "submit", "session", "dialog", "edit", "restore"] as const) {
  test(`late Herdr context is discarded after ${change}`, async () => {
    await using tmp = await tmpdir()
    await using fixture = await herdrFixture(tmp.path, true)
    await using view = await mount(tmp.path, "metadata-session")
    await view.waitForFrame((frame) => frame.includes("Metadata Model"))
    view.prompt().set({ input: change === "edit" ? "/herdr workspace" : "Original draft", parts: [] })
    if (change === "edit") view.app.mockInput.pressEnter()
    if (change !== "edit") {
      view.ctx().keymap.dispatchCommand("prompt.herdr")
      await view.waitForFrame((frame) => frame.includes("Gather Herdr sessions"))
      view.app.mockInput.pressEnter()
    }
    await fixture.wait("started")
    expect(view.prompt().gatheringHerdr).toBe(true)
    if (change === "reset") {
      view.prompt().reset()
      view.prompt().set({ input: "New draft", parts: [] })
    }
    if (change === "submit") {
      view.app.mockInput.pressEnter()
      await view.waitForFrame(() => view.submitted.length === 1)
      view.prompt().set({ input: "Next draft", parts: [] })
    }
    if (change === "session") view.setSession("other-session")
    if (change === "dialog") {
      view.ctx().keymap.dispatchCommand("model.list")
      await view.waitForFrame((frame) => frame.includes("Select model"))
    }
    if (change === "edit") {
      view.prompt().set({
        input: "/herdr workspace question [Image 1]",
        parts: [
          {
            type: "file",
            mime: "image/png",
            url: "data:image/png;base64,aGVsbG8=",
            source: { type: "file", path: "image.png", text: { value: "[Image 1]", start: 26, end: 35 } },
          },
        ],
      })
    }
    if (change === "restore") {
      const input = textarea(view.app.renderer.root, "Original draft")
      if (!input) throw new Error("Prompt textarea not found")
      input.insertText("x")
      expect(input.plainText).not.toBe("Original draft")
      await view.waitForFrame(() => view.prompt().current.input !== "Original draft")
      expect(view.prompt().current.input).not.toBe("Original draft")
      input.setText("Original draft")
      await view.waitForFrame(() => view.prompt().current.input === "Original draft")
      expect(input.plainText).toBe("Original draft")
      expect(view.prompt().current.input).toBe("Original draft")
    }
    await fixture.release()
    await fixture.wait("completed")
    await view.waitForFrame(() => !view.prompt().gatheringHerdr)
    expect(view.prompt().current.input).toBe(
      change === "reset"
        ? "New draft"
        : change === "submit"
          ? "Next draft"
          : change === "edit"
            ? "/herdr workspace question [Image 1]"
            : "Original draft",
    )
    expect(view.prompt().current.parts.filter((part) => part.type === "text")).toHaveLength(0)
    if (change === "edit") expect(view.prompt().current.parts).toHaveLength(1)
    if (change === "dialog") {
      expect(view.ctx().dialog.stack).toHaveLength(1)
      expect(view.prompt().focused).toBe(false)
    }
    expect(view.submitted).toHaveLength(change === "submit" ? 1 : 0)
  })
}

test("Herdr palette gathering and cancellation preserve prose, folded text, and image extmarks", async () => {
  await using tmp = await tmpdir()
  await using fixture = await herdrFixture(tmp.path)
  await using view = await mount(tmp.path, "metadata-session")
  await view.waitForFrame((frame) => frame.includes("Metadata Model"))
  const draft = {
    input: "Review [Pasted text] [Image 1]",
    parts: [
      {
        type: "text" as const,
        text: "Existing folded context",
        source: { text: { value: "[Pasted text]", start: 7, end: 20 } },
      },
      {
        type: "file" as const,
        mime: "image/png",
        url: "data:image/png;base64,aGVsbG8=",
        source: { type: "file" as const, path: "image.png", text: { value: "[Image 1]", start: 21, end: 30 } },
      },
    ],
  }
  view.prompt().set(draft)
  view.ctx().keymap.dispatchCommand("prompt.herdr")
  await view.waitForFrame((frame) => frame.includes("Gather Herdr sessions"))
  view.app.mockInput.pressEscape()
  await view.waitForFrame(() => view.ctx().dialog.stack.length === 0)
  expect(view.prompt().current).toEqual(draft)
  view.ctx().keymap.dispatchCommand("prompt.herdr")
  await view.waitForFrame((frame) => frame.includes("Gather Herdr sessions"))
  view.app.mockInput.pressEnter()
  await view.waitForFrame((frame) => frame.includes("[Herdr workspace: 1 OpenCode panes]"))
  expect(view.prompt().current.parts).toHaveLength(3)
  view.app.mockInput.pressEnter()
  await view.waitForFrame(() => view.submitted.length === 1)
  expect(view.submitted[0].body).toEqual(
    expect.objectContaining({
      parts: expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("Existing folded context") }),
        expect.objectContaining({ type: "file", mime: "image/png", url: draft.parts[1].url }),
      ]),
    }),
  )
  expect(JSON.stringify(view.submitted[0].body)).toContain("Session: metadata-session")
  expect(JSON.stringify(view.submitted[0].body)).not.toContain("[Pasted text]")
  expect(JSON.stringify(view.submitted[0].body)).not.toContain("[Herdr workspace:")
})

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

for (const sessionID of [undefined, "metadata-session"]) {
  test(`Herdr commands attach context on ${sessionID ? "chat session" : "home"} without sending a prompt`, async () => {
    await using tmp = await tmpdir()
    const env = { PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV }
    await Bun.write(
      `${tmp.path}/herdr`,
      `#!${process.execPath}
if (await Bun.file(import.meta.dir + "/failure").text().catch(() => "") === "1") { console.error("Herdr unavailable"); process.exit(1) }
const pane = { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "opencode", agent_status: "working", terminal_title_stripped: "OC | Test task", cwd: "/test/repo", agent_session: { agent: "opencode", kind: "id", value: "metadata-session" } }
const args = process.argv.slice(2)
const result = args[1] === "current" ? { pane } : args[0] === "pane" ? { panes: [pane] } : args[0] === "tab" ? { tabs: [{ tab_id: "w1:t1", label: "Test tab" }] } : { workspaces: [{ workspace_id: "w1", label: "Test workspace" }] }
console.log(JSON.stringify({ result }))
`,
    )
    await chmod(`${tmp.path}/herdr`, 0o755)
    process.env.PATH = `${tmp.path}:${env.PATH}`
    process.env.HERDR_ENV = "1"
    try {
      await using view = await mount(tmp.path, sessionID)
      await view.waitForFrame((frame) => frame.includes("Metadata Model"))
      view.prompt().set({ input: "/herdr unsupported", parts: [] })
      view.app.mockInput.pressEnter()
      await view.waitForFrame(() => !!view.ctx().toast.currentToast?.message.includes("Usage: /herdr"))
      expect(view.prompt().current.input).toBe("/herdr unsupported")
      expect(view.submitted).toHaveLength(0)
      await Bun.write(`${tmp.path}/failure`, "1")
      view.prompt().set({ input: "/herdr workspace", parts: [] })
      view.app.mockInput.pressEnter()
      await view.waitForFrame(() => !!view.ctx().toast.currentToast?.message.includes("Herdr unavailable"))
      expect(view.prompt().current.input).toBe("/herdr workspace")
      expect(view.submitted).toHaveLength(0)
      await Bun.write(`${tmp.path}/failure`, "0")
      for (const scope of ["tab", "workspace", "all"]) {
        view.prompt().set({ input: `/herdr ${scope}`, parts: [] })
        view.app.mockInput.pressEnter()
        await view.waitForFrame((frame) => frame.includes(`[Herdr ${scope}: 1 OpenCode panes]`))
        expect(view.submitted).toHaveLength(0)
        expect(view.prompt().current.parts).toContainEqual(
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining('Tab "Test tab" (w1:t1)'),
          }),
        )
      }
      view.prompt().set({ input: "/herdr ", parts: [] })
      view.app.mockInput.pressEnter()
      await view.waitForFrame((frame) => frame.includes("Gather Herdr sessions") && frame.includes("Current workspace"))
      expect(view.prompt().current.input).toBe("")
      view.app.mockInput.pressEnter()
      await view.waitForFrame((frame) => frame.includes("[Herdr workspace: 1 OpenCode panes]"))
      expect(view.submitted).toHaveLength(0)
      if (!sessionID) return
      const context = view.prompt().current
      view.prompt().set({ ...context, input: `${context.input}What is working?` })
      view.app.mockInput.pressEnter()
      await view.waitForFrame(() => view.submitted.length > 0)
      expect(view.submitted[0].body).toEqual(
        expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining("Session: metadata-session"),
            }),
          ]),
        }),
      )
      expect(JSON.stringify(view.submitted[0].body)).toContain("What is working?")
      expect(JSON.stringify(view.submitted[0].body)).not.toContain("[Herdr workspace:")
    } finally {
      Object.entries(env).forEach(([key, value]) => {
        if (value === undefined) {
          delete process.env[key]
          return
        }
        process.env[key] = value
      })
    }
  })
}

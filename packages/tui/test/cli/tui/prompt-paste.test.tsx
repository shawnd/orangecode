/** @jsxImportSource @opentui/solid */
import { MouseButton, TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createMemo, createSignal, Match, onCleanup, Switch } from "solid-js"
import { getPromptDraft, Prompt, type PromptRef } from "../../../src/component/prompt"
import { FrecencyProvider } from "../../../src/component/prompt/frecency"
import { TuiConfigProvider, useTuiConfig } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClipboardProvider, type ClipboardContent, type ClipboardService } from "../../../src/context/clipboard"
import { DataProvider } from "../../../src/context/data"
import { EditorContextProvider } from "../../../src/context/editor"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider, useKV } from "../../../src/context/kv"
import { LocalProvider } from "../../../src/context/local"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { SDKProvider, useSDK } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider, useTheme } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useOpencodeKeymap } from "../../../src/keymap"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider, useToast } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createFetch, directory, eventSource, json, worktree } from "../../fixture/tui-sdk"
import { annotationPrompt } from "../../../src/feature-plugins/system/diff-viewer-review"
import type { PromptInfo } from "../../../src/prompt/history"
import { Home } from "../../../src/routes/home"
import { PromptRefProvider, usePromptRef } from "../../../src/context/prompt"
import { useEvent } from "../../../src/context/event"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { createTuiApi, createTuiApiAdapters } from "../../../src/plugin/adapters"
import diffViewerPlugin from "../../../src/feature-plugins/system/diff-viewer"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTuiAttention } from "../../../src/attention"

async function mount(root: string, clipboard: ClipboardService, sessionID?: string, homeDraft?: PromptInfo) {
  const cleanup: Promise<void>[] = []
  await Bun.write(`${root}/kv.json`, JSON.stringify({ animations_enabled: false }))
  const calls = createFetch((url) => {
    if (url.pathname === "/config/providers") return json({ providers: [], default: {} })
    if (url.pathname.startsWith("/session/")) return json([])
    if (url.pathname === "/vcs/diff")
      return json([
        {
          file: "review.txt",
          additions: 1,
          deletions: 1,
          status: "modified",
          patch: "--- a/review.txt\n+++ b/review.txt\n@@ -1 +1 @@\n-old\n+new",
        },
      ])
  })
  const [disabled, setDisabled] = createSignal(false)
  let prompt: PromptRef | undefined
  let promptContext: ReturnType<typeof usePromptRef> | undefined
  let api: TuiPluginApi | undefined
  const runtime = createPluginRuntime()
  function Input() {
    const sync = useSync()
    promptContext = usePromptRef()
    if (homeDraft) return <ReviewRoutes />
    return (
      <Prompt
        sessionID={sessionID}
        visible={sync.ready}
        disabled={disabled()}
        placeholders={{ normal: ["Paste here"] }}
        ref={(value) => (prompt = value)}
      />
    )
  }
  function ReviewRoutes() {
    const route = useRoute()
    const renderer = useRenderer()
    const config = useTuiConfig()
    const kv = useKV()
    const attention = createTuiAttention({ renderer, config, kv })
    onCleanup(() => attention.dispose())
    api = createTuiApi(
      createTuiApiAdapters({
        version: "test",
        tuiConfig: config,
        dialog: useDialog(),
        keymap: useOpencodeKeymap(),
        kv,
        route,
        routes: runtime.routes,
        event: useEvent(),
        sdk: useSDK(),
        sync: useSync(),
        theme: useTheme(),
        toast: useToast(),
        renderer,
        attention,
        Slot: runtime.Slot,
      }),
    )
    onCleanup(runtime.setupSlots(api).dispose)
    void diffViewerPlugin.tui(api, undefined, {
      id: "diff-viewer",
      source: "internal",
      spec: "diff-viewer",
      target: "diff-viewer",
      first_time: 0,
      last_time: 0,
      time_changed: 0,
      load_count: 1,
      fingerprint: "test",
      state: "same",
    })
    const plugin = createMemo(() => {
      if (route.data.type !== "plugin") return
      return runtime.routes.get(route.data.id)?.({ params: route.data.data })
    })
    return (
      <box width="100%" height="100%" flexDirection="column">
        <Switch>
          <Match when={route.data.type === "home"}>
            <Home />
          </Match>
        </Switch>
        {plugin()}
      </box>
    )
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ theme: "opencode" })
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
                    <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={eventSource()}>
                      <PermissionProvider>
                        <ProjectProvider>
                          <ExitProvider
                            exit={(error) => {
                              throw error ?? new Error("Unexpected exit")
                            }}
                          >
                            <SyncProvider>
                              <DataProvider>
                                <RouteProvider
                                  initialRoute={homeDraft ? { type: "home", prompt: homeDraft } : undefined}
                                >
                                  <LocalProvider onDispose={(done) => cleanup.push(done)}>
                                    <ClipboardProvider value={clipboard}>
                                      <PromptStashProvider>
                                        <DialogProvider>
                                          <FrecencyProvider>
                                            <PromptHistoryProvider>
                                              <EditorContextProvider>
                                                <LocationProvider>
                                                  <PluginRuntimeProvider value={runtime}>
                                                    <PromptRefProvider>
                                                      <Input />
                                                    </PromptRefProvider>
                                                  </PluginRuntimeProvider>
                                                </LocationProvider>
                                              </EditorContextProvider>
                                            </PromptHistoryProvider>
                                          </FrecencyProvider>
                                        </DialogProvider>
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
  async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 2000
    while (true) {
      await app.renderOnce()
      if (predicate()) return
      if (Date.now() > deadline) throw new Error(`Timed out waiting for prompt:\n${app.captureCharFrame()}`)
      await Bun.sleep(10)
    }
  }
  await waitFor(() => app.captureCharFrame().includes(homeDraft ? homeDraft.input : "Paste here"))
  const input = app.renderer.currentFocusedRenderable
  if (!(input instanceof TextareaRenderable)) throw new Error("Prompt is not focused")
  return {
    app,
    input,
    setDisabled,
    waitFor,
    click(button: MouseButton.LEFT | MouseButton.RIGHT = MouseButton.RIGHT) {
      return app.mockMouse.click(input.x + input.width - 1, input.y, button)
    },
    current() {
      const ref = promptContext?.current ?? prompt
      if (!ref) throw new Error("Prompt is not mounted")
      return ref.current
    },
    set(promptInfo: PromptInfo) {
      if (!prompt) throw new Error("Prompt is not mounted")
      prompt.set(promptInfo)
    },
    api() {
      if (!api) throw new Error("Plugin API is not mounted")
      return api
    },
    async [Symbol.asyncDispose]() {
      ;(promptContext?.current ?? prompt)?.reset()
      app.renderer.destroy()
      await Promise.all(cleanup)
    },
  }
}

test("Home → diff → Home restores the live draft and annotations through the real route adapter", async () => {
  await using tmp = await tmpdir()
  await using view = await mount(tmp.path, { read: async () => undefined }, undefined, {
    input: "Original [Image 1]",
    parts: [
      {
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,aW1hZ2U=",
        source: { type: "file", path: "image.png", text: { value: "[Image 1]", start: 9, end: 18 } },
      },
    ],
  })
  view.input.gotoBufferEnd()
  view.input.insertText(" edited")
  await view.waitFor(() => view.current().input.endsWith(" edited"))
  await view.api().keymap.dispatchCommand("diff.open")
  await view.waitFor(() => view.app.captureCharFrame().includes("review.txt"))
  view.app.mockInput.typeText("a")
  await view.waitFor(() => view.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const editor = view.app.renderer.currentFocusedEditor as TextareaRenderable
  editor.setText("Preserve the behavior")
  view.app.mockInput.pressEnter()
  await view.waitFor(() => view.app.captureCharFrame().includes("Preserve the behavior"))
  const chooseSource = async (title: string) => {
    await view.api().keymap.dispatchCommand("diff.switch_source")
    await view.waitFor(() => view.app.captureCharFrame().includes(title))
    const lines = view.app.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes(title))
    await view.app.mockMouse.click(lines[row].indexOf(title), row)
  }
  await chooseSource("Last turn")
  await view.waitFor(() => view.app.captureCharFrame().includes("No diff!"))
  await chooseSource("Working tree")
  await view.waitFor(() => view.app.captureCharFrame().includes("Preserve the behavior"))
  view.app.mockInput.typeText("q")
  await view.waitFor(() => view.app.captureCharFrame().includes("Diff annotations · edit"))
  expect(view.current().input).toBe("Original [Image 1] edited\n\n[Diff annotations: 1 comment · 1 file]")
  expect(view.current().parts[0]).toMatchObject({ type: "file", mime: "image/png" })
  const part = view.current().parts[1]
  if (part.type !== "text") throw new Error("Expected annotation text")
  expect(part.text).toContain("Preserve the behavior")
  await view.api().keymap.dispatchCommand("diff.open")
  await view.waitFor(() => view.app.captureCharFrame().includes("review.txt"))
  view.app.mockInput.typeText("q")
  await view.waitFor(() => view.app.captureCharFrame().includes("Diff annotations · edit"))
  expect(view.current().parts).toHaveLength(2)
  const draft = getPromptDraft()
  view.api().route.navigate("session", { sessionID: "review-session", prompt: draft })
  expect(view.api().route.current).toEqual({ name: "session", params: { sessionID: "review-session", prompt: draft } })
  view.api().route.navigate("home", { prompt: draft })
  await view.waitFor(() => view.app.captureCharFrame().includes("Diff annotations · edit"))
})

test("compact annotations can be edited and expanded without losing later attachments", async () => {
  await using tmp = await tmpdir()
  await using view = await mount(tmp.path, {
    async read() {
      return undefined
    },
  })
  const draft = annotationPrompt(
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
        comment: "Fix this",
      },
    ],
    { input: "Review", parts: [] },
  )
  view.set({
    ...draft,
    input: draft.input + "\n@build",
    parts: [
      ...draft.parts,
      {
        type: "agent",
        name: "build",
        source: { start: draft.input.length + 1, end: draft.input.length + 7, value: "@build" },
      },
    ],
  })
  expect(getPromptDraft()).toEqual(view.current())
  const click = async (text: string) => {
    await view.waitFor(() => view.app.captureCharFrame().includes(text))
    const lines = view.app.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes(text))
    await view.app.mockMouse.click(lines[row].indexOf(text), row)
    await view.app.renderOnce()
  }
  await click("Diff annotations · edit")
  await view.waitFor(
    () =>
      view.app.renderer.currentFocusedEditor !== view.input &&
      view.app.renderer.currentFocusedEditor instanceof TextareaRenderable,
  )
  const editor = view.app.renderer.currentFocusedEditor as TextareaRenderable
  expect(editor.plainText).toContain("Fix this")
  editor.setText("Updated review message")
  view.app.mockInput.pressEnter()
  await view.waitFor(() =>
    view.current().parts.some((part) => part.type === "text" && part.text === "Updated review message"),
  )
  expect(view.current().input).toContain("[Diff annotations:")
  await click("expand into input")
  await view.waitFor(() => view.current().input.includes("Updated review message"))
  expect(view.current().input).toBe("Review\n\nUpdated review message\n@build")
  expect(view.current().parts).toEqual([
    { type: "agent", name: "build", source: { start: 31, end: 37, value: "@build" } },
  ])
})

test("disabled annotation controls ignore clicks and saving empty review text removes only its attachment", async () => {
  await using tmp = await tmpdir()
  await using view = await mount(tmp.path, { read: async () => undefined })
  const draft = annotationPrompt(
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
        comment: "Fix this",
      },
    ],
    { input: "Review", parts: [] },
  )
  const suffix = "\n@build [Image 1] [Pasted]"
  view.set({
    ...draft,
    input: draft.input + suffix,
    parts: [
      ...draft.parts,
      {
        type: "agent",
        name: "build",
        source: { start: draft.input.length + 1, end: draft.input.length + 7, value: "@build" },
      },
      {
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,aW1hZ2U=",
        source: {
          type: "file",
          path: "image.png",
          text: { start: draft.input.length + 8, end: draft.input.length + 17, value: "[Image 1]" },
        },
      },
      {
        type: "text",
        text: "Other pasted text",
        source: { text: { start: draft.input.length + 18, end: draft.input.length + 26, value: "[Pasted]" } },
      },
    ],
  })
  const click = async (text: string) => {
    await view.waitFor(() => view.app.captureCharFrame().includes(text))
    const lines = view.app.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes(text))
    await view.app.mockMouse.click(lines[row].indexOf(text), row)
    await view.app.renderOnce()
  }
  view.setDisabled(true)
  await view.app.renderOnce()
  await click("expand into input")
  await click("Diff annotations · edit")
  expect(view.current().input).toBe(draft.input + suffix)
  expect(view.app.captureCharFrame()).not.toContain("Edit diff annotations")
  view.setDisabled(false)
  await view.app.renderOnce()
  await click("Diff annotations · edit")
  await view.waitFor(
    () =>
      view.app.renderer.currentFocusedEditor instanceof TextareaRenderable &&
      view.app.renderer.currentFocusedEditor !== view.input,
  )
  const editor = view.app.renderer.currentFocusedEditor as TextareaRenderable
  editor.setText("")
  view.app.mockInput.pressEnter()
  await view.waitFor(() => view.current().parts.length === 3)
  expect(view.current().input).toBe("Review\n\n" + suffix)
  expect(getPromptDraft()?.parts).toMatchObject([
    { type: "agent", source: { start: 9, end: 15, value: "@build" } },
    { type: "file", source: { text: { start: 16, end: 25, value: "[Image 1]" } } },
    { type: "text", text: "Other pasted text", source: { text: { start: 26, end: 34, value: "[Pasted]" } } },
  ])
  expect(view.app.captureCharFrame()).not.toContain("Diff annotations · edit")
})

for (const sessionID of [undefined, "paste-session"]) {
  test(`right-click pastes once at the cursor on ${sessionID ? "session" : "home"}`, async () => {
    await using tmp = await tmpdir()
    const reads: string[] = []
    await using view = await mount(
      tmp.path,
      {
        async read() {
          reads.push("read")
          return { data: "clipboard\r\ntext", mime: "text/plain" }
        },
      },
      sessionID,
    )
    view.input.setText("before after")
    await view.app.renderOnce()
    await view.click(MouseButton.LEFT)
    expect(reads).toEqual([])
    view.input.cursorOffset = 7
    await view.click()
    await view.waitFor(() => view.input.plainText.includes("clipboard"))
    expect(view.input.plainText).toBe("before clipboard\ntextafter")
    expect(reads).toEqual(["read"])
  })
}

test("disabled input ignores right-click paste", async () => {
  await using tmp = await tmpdir()
  const reads: string[] = []
  await using view = await mount(tmp.path, {
    async read() {
      reads.push("read")
      return { data: "clipboard", mime: "text/plain" }
    },
  })
  view.setDisabled(true)
  await view.app.renderOnce()
  await view.click()
  expect(reads).toEqual([])
  expect(view.input.plainText).toBe("")
})

test("disabling the input during a clipboard read prevents insertion", async () => {
  await using tmp = await tmpdir()
  const content = Promise.withResolvers<ClipboardContent | undefined>()
  const reads: string[] = []
  await using view = await mount(tmp.path, {
    read() {
      reads.push("read")
      return content.promise
    },
  })
  await view.click()
  expect(reads).toEqual(["read"])
  view.setDisabled(true)
  await view.app.renderOnce()
  content.resolve({ data: "late clipboard", mime: "text/plain" })
  await content.promise
  await view.app.renderOnce()
  expect(view.input.plainText).toBe("")
})

test("right-click uses paste summaries and image attachments", async () => {
  await using tmp = await tmpdir()
  const contents = [
    { data: "first line\nsecond line\nthird line", mime: "text/plain" },
    { data: "aW1hZ2U=", mime: "image/png" },
  ]
  await using view = await mount(tmp.path, { read: async () => contents.shift() })
  await view.click()
  await view.waitFor(() => view.current().parts.length === 1)
  expect(view.input.plainText).toBe("[Pasted ~3 lines] ")
  expect(view.current().parts[0]).toMatchObject({ type: "text", text: "first line\nsecond line\nthird line" })
  await view.click()
  await view.waitFor(() => view.current().parts.length === 2)
  expect(view.input.plainText).toBe("[Pasted ~3 lines] [Image 1] ")
  expect(view.current().parts[1]).toMatchObject({
    type: "file",
    mime: "image/png",
    url: "data:image/png;base64,aW1hZ2U=",
  })
})

test("missing clipboard content leaves the draft unchanged", async () => {
  await using tmp = await tmpdir()
  await using view = await mount(tmp.path, { read: async () => undefined })
  view.input.setText("draft")
  await view.app.renderOnce()
  await view.click()
  expect(view.input.plainText).toBe("draft")
})

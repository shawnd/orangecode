/** @jsxImportSource @opentui/solid */
import { MouseButton, TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, onCleanup } from "solid-js"
import { Prompt, type PromptRef } from "../../../src/component/prompt"
import { FrecencyProvider } from "../../../src/component/prompt/frecency"
import { TuiConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClipboardProvider, type ClipboardContent, type ClipboardService } from "../../../src/context/clipboard"
import { DataProvider } from "../../../src/context/data"
import { EditorContextProvider } from "../../../src/context/editor"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { LocalProvider } from "../../../src/context/local"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { RouteProvider } from "../../../src/context/route"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createFetch, directory, eventSource, json, worktree } from "../../fixture/tui-sdk"

async function mount(root: string, clipboard: ClipboardService, sessionID?: string) {
  await Bun.write(`${root}/kv.json`, JSON.stringify({ animations_enabled: false }))
  const calls = createFetch((url) => {
    if (url.pathname === "/config/providers") return json({ providers: [], default: {} })
    if (url.pathname.startsWith("/session/")) return json([])
  })
  const [disabled, setDisabled] = createSignal(false)
  let prompt: PromptRef | undefined
  function Input() {
    const sync = useSync()
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
                                <RouteProvider>
                                  <LocalProvider>
                                    <ClipboardProvider value={clipboard}>
                                      <PromptStashProvider>
                                        <DialogProvider>
                                          <FrecencyProvider>
                                            <PromptHistoryProvider>
                                              <EditorContextProvider>
                                                <LocationProvider>
                                                  <Input />
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
  await waitFor(() => app.captureCharFrame().includes("Paste here"))
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
      if (!prompt) throw new Error("Prompt is not mounted")
      return prompt.current
    },
    [Symbol.dispose]() {
      prompt?.reset()
      app.renderer.destroy()
    },
  }
}

for (const sessionID of [undefined, "paste-session"]) {
  test(`right-click pastes once at the cursor on ${sessionID ? "session" : "home"}`, async () => {
    await using tmp = await tmpdir()
    const reads: string[] = []
    using view = await mount(
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
  using view = await mount(tmp.path, {
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
  using view = await mount(tmp.path, {
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
  using view = await mount(tmp.path, { read: async () => contents.shift() })
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
  using view = await mount(tmp.path, { read: async () => undefined })
  view.input.setText("draft")
  await view.app.renderOnce()
  await view.click()
  expect(view.input.plainText).toBe("draft")
})

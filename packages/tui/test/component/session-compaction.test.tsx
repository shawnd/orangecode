/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import type { PromptInfo } from "../../src/component/prompt/history"
import { TuiConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider } from "../../src/context/clipboard"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { SidebarContextView } from "../../src/feature-plugins/sidebar/context"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { CompactionMessage } from "../../src/routes/session/compaction-message"
import { DialogTimeline } from "../../src/routes/session/dialog-timeline"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { compactedSession } from "../fixture/compacted-session"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createFetch, directory, eventSource, json } from "../fixture/tui-sdk"

async function mount(root: string) {
  const fixture = compactedSession()
  const requests: unknown[] = []
  const prompts: PromptInfo[] = []
  const moves: string[] = []
  let sync!: ReturnType<typeof useSync>
  let dialog!: ReturnType<typeof useDialog>
  const calls = createFetch(async (url, request) => {
    if (url.pathname === "/session/parent/revert") {
      requests.push(await request?.json())
      const info = { ...fixture.session, revert: { messageID: "msg_a-compact" } }
      sync.set("session", [info])
      return json(info)
    }
  })
  function Body() {
    sync = useSync()
    dialog = useDialog()
    const api = createTuiPluginApi({
      state: {
        session: {
          get: (id) => sync.session.get(id),
          messages: (id) => sync.data.message[id] ?? [],
        },
      },
    })
    Object.assign(api.state, { provider: [] })
    return (
      <box>
        <CompactionMessage messageID="msg_a-compact" sessionID="parent" setPrompt={(prompt) => prompts.push(prompt)} />
        <SidebarContextView api={api} session_id="parent" />
      </box>
    )
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ theme: "opencode" })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={directory} paths={{ state: root, home: root }}>
        <ArgsProvider>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <ClipboardProvider value={{}}>
                      <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={eventSource()}>
                        <PermissionProvider>
                          <ProjectProvider>
                            <ExitProvider exit={() => {}}>
                              <SyncProvider>
                                <RouteProvider>
                                  <DialogProvider>
                                    <Body />
                                  </DialogProvider>
                                </RouteProvider>
                              </SyncProvider>
                            </ExitProvider>
                          </ProjectProvider>
                        </PermissionProvider>
                      </SDKProvider>
                    </ClipboardProvider>
                  </ToastProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </ArgsProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width: 100, height: 35, useThread: false })
  async function wait(predicate: () => boolean) {
    const deadline = Date.now() + 3000
    while (!predicate()) {
      await app.renderOnce()
      if (Date.now() > deadline) throw new Error(`Compaction UI did not settle:\n${app.captureCharFrame()}`)
      await Bun.sleep(10)
    }
    await app.renderOnce()
  }
  await wait(() => !!sync?.ready)
  sync.set("session", [fixture.session])
  sync.set("message", "parent", fixture.messages)
  sync.set("part", fixture.parts)
  await app.renderOnce()
  return {
    app,
    sync,
    dialog,
    fixture,
    requests,
    prompts,
    moves,
    wait,
    timeline() {
      dialog.replace(() => (
        <DialogTimeline
          sessionID="parent"
          onMove={(id) => moves.push(id)}
          setPrompt={(prompt) => prompts.push(prompt)}
        />
      ))
    },
    async click(label: string) {
      await wait(() => app.captureCharFrame().includes(label))
      const lines = app.captureCharFrame().split("\n")
      const row = lines.findIndex((line) => line.includes(label))
      await app.mockMouse.click(lines[row].indexOf(label) + 1, row)
      await app.renderOnce()
    },
    [Symbol.dispose]() {
      app.renderer.destroy()
    },
  }
}

test("clicking the compaction marker opens undo and submits the compaction boundary", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path)
  expect(view.app.captureCharFrame()).toContain("12,000 tokens")
  await view.click("Compaction")
  await view.wait(() => view.app.captureCharFrame().includes("Undo compaction"))
  expect(view.app.captureCharFrame()).toContain("restore context before")
  await view.app.mockInput.pressEnter()
  await view.wait(() => view.requests.length === 1 && view.dialog.stack.length === 0)
  expect(view.requests).toEqual([{ messageID: "msg_a-compact" }])
  expect(view.prompts).toEqual([{ input: "/compact", parts: [] }])
  expect(view.sync.session.get("parent")?.revert?.messageID).toBe("msg_a-compact")
  expect(view.app.captureCharFrame()).toContain("90,000 tokens")
})

test("timeline includes compaction, excludes synthetic continuation, and opens the same undo action", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path)
  view.timeline()
  await view.wait(() => view.app.captureCharFrame().includes("/compact"))
  const frame = view.app.captureCharFrame()
  expect(frame).toContain("Original question")
  expect(frame).not.toContain("Internal continuation")
  expect(frame.indexOf("/compact")).toBeLessThan(frame.indexOf("Original question"))
  await view.app.mockInput.pressArrow("down")
  await view.wait(() => view.moves.includes("msg_z-user"))
  await view.app.mockInput.pressArrow("up")
  await view.wait(() => view.moves.at(-1) === "msg_a-compact")
  await view.app.mockInput.pressEnter()
  await view.wait(() => view.app.captureCharFrame().includes("Undo compaction"))
  await view.app.mockInput.pressEnter()
  await view.wait(() => view.requests.length === 1)
  expect(view.requests).toEqual([{ messageID: "msg_a-compact" }])
  expect(view.prompts).toEqual([{ input: "/compact", parts: [] }])
})

test("sidebar context follows undo, redo, and an empty active history", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path)
  expect(view.app.captureCharFrame()).toContain("12,000 tokens")
  view.sync.set("session", [{ ...view.fixture.session, revert: { messageID: "msg_a-compact" } }])
  await view.app.renderOnce()
  expect(view.app.captureCharFrame()).toContain("90,000 tokens")
  view.sync.set("session", [view.fixture.session])
  await view.app.renderOnce()
  expect(view.app.captureCharFrame()).toContain("12,000 tokens")
  view.sync.set("session", [{ ...view.fixture.session, revert: { messageID: "msg_z-user" } }])
  await view.app.renderOnce()
  expect(view.app.captureCharFrame()).toContain("0 tokens")
  expect(view.app.captureCharFrame()).not.toContain("12,000 tokens")
})

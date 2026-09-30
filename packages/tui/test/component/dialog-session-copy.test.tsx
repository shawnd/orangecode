/** @jsxImportSource @opentui/solid */
import { InputRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import path from "path"
import { onCleanup, onMount } from "solid-js"
import { DialogSessionList } from "../../src/component/dialog-session-list"
import { TuiConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider, type ClipboardService } from "../../src/context/clipboard"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { LocalProvider } from "../../src/context/local"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider, useRoute } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { Toast, ToastProvider, useToast } from "../../src/ui/toast"
import { writeJsonAtomic } from "../../src/util/persistence"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createFetch, directory, eventSource, json } from "../fixture/tui-sdk"

const sessions = ["Current session", "Selected session"].map((title, index) => ({
  id: `ses_copy_test_${index}`,
  title,
  directory,
  time: { created: Date.now(), updated: Date.now() - index * 1000 },
}))

async function wait(predicate: () => boolean) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for session palette")
    await Bun.sleep(10)
  }
}

async function mount(root: string, clipboard: ClipboardService, options?: { empty?: boolean; binding?: string }) {
  await writeJsonAtomic(path.join(root, "kv.json"), { animations_enabled: false })
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json(options?.empty ? [] : sessions)
  })
  let dialog!: ReturnType<typeof useDialog>
  let toast!: ReturnType<typeof useToast>
  let route!: ReturnType<typeof useRoute>
  let sync!: ReturnType<typeof useSync>
  function Palette() {
    dialog = useDialog()
    toast = useToast()
    route = useRoute()
    sync = useSync()
    onMount(() => {
      route.navigate({ type: "session", sessionID: sessions[0]!.id })
      dialog.replace(() => <DialogSessionList />)
    })
    return <Toast />
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({
      theme: "opencode",
      keybinds: options?.binding ? { session_copy_id: options.binding } : {},
    })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={directory} paths={{ state: root, home: root }}>
        <ArgsProvider>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <ClipboardProvider value={clipboard}>
                      <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={eventSource()}>
                        <PermissionProvider>
                          <ProjectProvider>
                            <ExitProvider exit={() => {}}>
                              <SyncProvider>
                                <RouteProvider>
                                  <LocalProvider>
                                    <DialogProvider>
                                      <Palette />
                                    </DialogProvider>
                                  </LocalProvider>
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
  const app = await testRender(() => <Harness />, { width: 120, height: 40 })
  await wait(() => !!sync?.ready && app.renderer.currentFocusedEditor instanceof InputRenderable)
  await app.renderOnce()
  return {
    app,
    dialog,
    toast,
    route,
    [Symbol.dispose]() {
      app.renderer.destroy()
    },
  }
}

test("ctrl+y copies the highlighted session ID, then dismisses and shows a toast", async () => {
  await using tmp = await tmpdir()
  const copied: string[] = []
  const pending = Promise.withResolvers<void>()
  using view = await mount(tmp.path, {
    write: (text) => {
      copied.push(text)
      return pending.promise
    },
  })
  expect(view.app.captureCharFrame()).toContain("copy ID")
  expect(view.app.captureCharFrame()).toContain("ctrl+y")
  view.app.mockInput.pressArrow("down")
  view.app.mockInput.pressKey("y", { ctrl: true })
  await wait(() => copied.length > 0)
  expect(copied).toEqual([sessions[1]!.id])
  expect(view.dialog.stack).toHaveLength(1)
  expect(view.toast.currentToast).toBeNull()
  pending.resolve()
  await wait(() => view.dialog.stack.length === 0)
  expect(view.toast.currentToast).toMatchObject({ message: "Session ID copied", variant: "info" })
  expect(view.route.data).toMatchObject({ type: "session", sessionID: sessions[0]!.id })
  await view.app.renderOnce()
  expect(view.app.captureCharFrame()).toContain("Session ID copied")
  expect(view.app.captureCharFrame()).not.toContain("Selected session")
})

test("clipboard failure keeps the palette open and displays an error toast", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path, {
    write: () => Promise.reject(new Error("Clipboard unavailable")),
  })
  view.app.mockInput.pressKey("y", { ctrl: true })
  await wait(() => view.toast.currentToast !== null)
  expect(view.dialog.stack).toHaveLength(1)
  expect(view.toast.currentToast).toMatchObject({ message: "Clipboard unavailable", variant: "error" })
})

test("ctrl+y does nothing when there is no selected session", async () => {
  await using tmp = await tmpdir()
  const copied: string[] = []
  using view = await mount(
    tmp.path,
    {
      write: async (text) => {
        copied.push(text)
      },
    },
    { empty: true },
  )
  view.app.mockInput.pressKey("y", { ctrl: true })
  await view.app.renderOnce()
  expect(copied).toEqual([])
  expect(view.dialog.stack).toHaveLength(1)
  expect(view.toast.currentToast).toBeNull()
})

test("session ID copy supports a configured shortcut", async () => {
  await using tmp = await tmpdir()
  const copied: string[] = []
  using view = await mount(
    tmp.path,
    {
      write: async (text) => {
        copied.push(text)
      },
    },
    { binding: "ctrl+k" },
  )
  expect(view.app.captureCharFrame()).toContain("ctrl+k")
  view.app.mockInput.pressKey("y", { ctrl: true })
  await view.app.renderOnce()
  expect(copied).toEqual([])
  view.app.mockInput.pressKey("k", { ctrl: true })
  await wait(() => view.dialog.stack.length === 0)
  expect(copied).toEqual([sessions[0]!.id])
})

test("copy is disabled when the clipboard service cannot write", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path, {})
  view.app.mockInput.pressKey("y", { ctrl: true })
  await view.app.renderOnce()
  expect(view.dialog.stack).toHaveLength(1)
  expect(view.toast.currentToast).toBeNull()
})

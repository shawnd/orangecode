/** @jsxImportSource @opentui/solid */
import { InputRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createEffect, onCleanup } from "solid-js"
import { DialogPermissions } from "../../../src/component/dialog-permissions"
import { TuiConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { LocalProvider } from "../../../src/context/local"
import { PermissionProvider, usePermission } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { RouteProvider } from "../../../src/context/route"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider, useTheme } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import opencodeTheme from "../../../src/theme/assets/opencode.json"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider, useToast } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createFetch, directory, eventSource, json, worktree } from "../../fixture/tui-sdk"

const before = {
  username: "keep-unrelated-settings",
  permission: { bash: "allow", external_directory: { "~/work/*": "ask", "$HOME/work/*": "deny" } },
} as const
const after = {
  ...before,
  permission: { bash: "allow", external_directory: { "~/work/*": "ask", "$HOME/work/*": "allow" } },
} as const
const originalRules = [
  { permission: "bash", pattern: "*", action: "allow" },
  { permission: "external_directory", pattern: "/server/home/work/*", action: "ask" },
  { permission: "external_directory", pattern: "/server/home/work/*", action: "deny" },
]
const savedRules = [originalRules[0], originalRules[1], { ...originalRules[2], action: "allow" }]
const patch = { permission: { external_directory: { "$HOME/work/*": "allow" } } }

async function mount(
  root: string,
  options: {
    width?: number
    height?: number
    failWrite?: boolean
    holdWrite?: Promise<void>
    failRefresh?: boolean
    monochrome?: boolean
  } = {},
) {
  await Bun.write(`${root}/kv.json`, "{}")
  const fallback = createFetch()
  const writes: { path: string; directory: string | null; body: unknown }[] = []
  const control = { failWrite: options.failWrite ?? false, saved: "" }
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (request.method === "PATCH") {
      writes.push({ path: url.pathname, directory: url.searchParams.get("directory"), body: await request.json() })
      await options.holdWrite
      if (control.failWrite) return json({ message: "Read-only configuration" }, { status: 500 })
      control.saved = url.pathname
      return json(after)
    }
    if (url.pathname === "/path") return json({ home: "/server/home", state: root, config: root, worktree, directory })
    if (url.pathname === "/config/providers") return json({ providers: [], default: {} })
    if (url.pathname === "/global/config") return json(control.saved === "/global/config" ? after : before)
    if (url.pathname === "/config") {
      if (control.saved && options.failRefresh) return json({ message: "Reload failed" }, { status: 500 })
      return json(control.saved ? after : before)
    }
    if (url.pathname === "/permission/status")
      return json({
        global: control.saved === "/global/config" ? savedRules : originalRules,
        configured: control.saved ? savedRules : originalRules,
        approved: [],
        pending: [],
      })
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", permission: [], options: {} }])
    return fallback.fetch(request)
  }) as typeof fetch
  let context:
    | {
        permission: ReturnType<typeof usePermission>
        sync: ReturnType<typeof useSync>
        toast: ReturnType<typeof useToast>
        theme: ReturnType<typeof useTheme>
      }
    | undefined
  function OpenDialog() {
    const dialog = useDialog()
    const sync = useSync()
    context = { sync, permission: usePermission(), toast: useToast(), theme: useTheme() }
    let opened = false
    createEffect(() => {
      if (!sync.ready || opened) return
      opened = true
      dialog.replace(() => <DialogPermissions />)
    })
    return <box />
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ theme: options.monochrome ? "permissions-test-monochrome" : "opencode" })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={directory} paths={{ state: root, home: "/server/home", worktree }}>
        <ArgsProvider>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider
                  mode="dark"
                  source={{
                    discover: async () => ({
                      "permissions-test-monochrome": {
                        ...opencodeTheme,
                        theme: { ...opencodeTheme.theme, success: "#aaaaaa" },
                      },
                    }),
                  }}
                >
                  <ToastProvider>
                    <SDKProvider url="http://test" directory={directory} fetch={fetcher} events={eventSource()}>
                      <PermissionProvider>
                        <ProjectProvider>
                          <ExitProvider
                            exit={(error) => {
                              throw error ?? new Error("Unexpected exit")
                            }}
                          >
                            <SyncProvider>
                              <RouteProvider>
                                <LocalProvider>
                                  <ClipboardProvider value={{}}>
                                    <DialogProvider>
                                      <OpenDialog />
                                    </DialogProvider>
                                  </ClipboardProvider>
                                </LocalProvider>
                              </RouteProvider>
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
  const app = await testRender(() => <Harness />, {
    width: options.width ?? 100,
    height: options.height ?? 40,
    kittyKeyboard: true,
  })
  const ctx = () => {
    if (!context) throw new Error("Dialog contexts not ready")
    return context
  }
  return {
    app,
    ctx,
    writes,
    control,
    async ready() {
      const deadline = Date.now() + 2000
      while (!context || !(app.renderer.currentFocusedEditor instanceof InputRenderable)) {
        if (Date.now() > deadline) throw new Error("Timed out initializing dialog providers and input focus")
        await Bun.sleep(10)
      }
      await app.renderOnce()
      await app.waitForFrame((frame) => frame.includes("3 rules") && frame.includes("Allow"))
      await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    },
    [Symbol.dispose]() {
      app.renderer.destroy()
    },
  }
}

function position(frame: string, text: string) {
  const lines = frame.split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  if (y === -1) throw new Error(`Missing ${JSON.stringify(text)} in frame:\n${frame}`)
  return { x: lines[y].indexOf(text), y }
}

async function chooseAlias(view: Awaited<ReturnType<typeof mount>>) {
  await view.app.mockInput.typeText("work")
  await view.app.waitForFrame((frame) => frame.includes("2/3 rules"))
  view.app.mockInput.pressArrow("down")
  view.app.mockInput.pressEnter()
  await view.app.waitForFrame((frame) => frame.includes("external_directory · $HOME/work/*"))
  view.app.mockInput.pressArrow("left")
  view.app.mockInput.pressArrow("left")
}

test("auto-approve works by keyboard and mouse without changing config", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path, { width: 48, height: 24 })
  await view.ready()
  expect(view.ctx().permission.mode).toBe("normal")
  view.app.mockInput.pressKey("t", { ctrl: true })
  const frame = await view.app.waitForFrame((frame) => frame.includes("Auto on"))
  expect(view.ctx().permission.mode).toBe("auto")
  const auto = position(frame, "Auto on")
  await view.app.mockMouse.click(auto.x, auto.y)
  await view.app.waitForFrame((frame) => frame.includes("Auto off"))
  expect(view.ctx().permission.mode).toBe("normal")
  expect(view.writes).toEqual([])
})

for (const scope of ["Global", "Config"] as const) {
  test(`${scope} editing filters and navigates real rules, sends a narrow raw-key patch, and refreshes`, async () => {
    await using tmp = await tmpdir()
    using view = await mount(tmp.path)
    await view.ready()
    if (scope === "Global") {
      view.app.mockInput.pressTab()
      await view.app.waitForFrame((frame) => frame.includes("Global rules"))
    }
    await chooseAlias(view)
    expect(view.app.captureCharFrame()).toContain(scope === "Global" ? "Edit global rule" : "Save directory override")
    expect(view.writes).toEqual([])
    view.app.mockInput.pressEnter()
    await view.app.waitFor(() => view.ctx().toast.currentToast?.variant === "success")
    await view.app.waitForFrame((frame) => frame.includes("2/3 rules"))
    expect(view.writes).toEqual([
      {
        path: scope === "Global" ? "/global/config" : "/config",
        directory: scope === "Config" ? directory : null,
        body: patch,
      },
    ])
    expect(view.ctx().sync.data.config).toEqual(after)
    expect(view.ctx().toast.currentToast?.message).toContain(scope === "Global" ? "global rule" : "directory override")
    expect(view.app.renderer.currentFocusedEditor).toBeInstanceOf(InputRenderable)
    expect(view.app.renderer.currentFocusedEditor?.plainText).toBe("work")
    // Inspect the refreshed rule via the editor, rather than trusting a success toast.
    view.app.mockInput.pressEnter()
    await view.app.waitForFrame((frame) => frame.includes("› ● allow"))
    view.app.mockInput.pressBackspace()
    await view.app.waitForFrame((frame) => frame.includes("2/3 rules"))
    expect(view.writes).toHaveLength(1)
  })
}

test("failed saves stay editable, prevent duplicate submissions, and can be retried without false success", async () => {
  await using tmp = await tmpdir()
  const gate = Promise.withResolvers<void>()
  using view = await mount(tmp.path, { failWrite: true, holdWrite: gate.promise })
  await view.ready()
  await chooseAlias(view)
  view.app.mockInput.pressEnter()
  await view.app.waitForFrame((frame) => frame.includes("Saving…"))
  await view.app.waitFor(() => view.writes.length === 1)
  view.app.mockInput.pressEnter()
  expect(view.writes).toHaveLength(1)
  expect(view.ctx().toast.currentToast).toBeNull()
  gate.resolve()
  const error = await view.app.waitForFrame((frame) => frame.includes("Read-only configuration"))
  expect(error).toContain("Save directory override")
  expect(error).toContain("enter save")
  expect(error).toContain("› ● allow")
  expect(view.ctx().toast.currentToast).toBeNull()
  expect(view.ctx().sync.data.config).toEqual(before)
  view.control.failWrite = false
  view.app.mockInput.pressEnter()
  await view.app.waitFor(() => view.ctx().toast.currentToast?.variant === "success")
  expect(view.writes.map((write) => write.body)).toEqual([patch, patch])
  expect(view.ctx().sync.data.config).toEqual(after)
})

test("a successful write followed by a failed reload does not claim success", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path, { failRefresh: true })
  await view.ready()
  await chooseAlias(view)
  view.app.mockInput.pressEnter()
  const frame = await view.app.waitForFrame((frame) => frame.includes("Saved, but refresh failed"))
  expect(frame).toContain("Save directory override")
  expect(view.writes).toHaveLength(1)
  expect(view.control.saved).toBe("/config")
  expect(view.ctx().toast.currentToast).toBeNull()
})

test("rule text is inert; the dedicated mouse edit control opens a cancellable chooser", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path, { width: 48, height: 24 })
  await view.ready()
  const rule = position(view.app.captureCharFrame(), "bash")
  await view.app.mockMouse.click(rule.x, rule.y)
  await view.app.flush()
  expect(view.app.captureCharFrame()).not.toContain("enter save")
  expect(view.writes).toEqual([])
  const edit = position(view.app.captureCharFrame(), "edit")
  await view.app.mockMouse.click(edit.x, edit.y)
  await view.app.waitForFrame((frame) => frame.includes("enter save"))
  expect(view.writes).toEqual([])
  view.app.mockInput.pressBackspace()
  await view.app.waitForFrame((frame) => frame.includes("3 rules"))
  expect(view.app.renderer.currentFocusedEditor).toBeInstanceOf(InputRenderable)
  expect(view.writes).toEqual([])
})

test("allow dots stay green and agree with the legend and chooser in a gray-success theme", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path, { monochrome: true })
  await view.ready()
  await view.app.waitFor(() => view.ctx().theme.selected === "permissions-test-monochrome" && view.ctx().theme.ready)
  for (const mode of ["dark", "light"] as const) {
    view.ctx().theme.setMode(mode)
    await view.app.flush()
    const frame = view.app.captureSpans()
    const rule = frame.lines.find((line) => line.spans.some((span) => span.text.includes("bash")))
    const legend = frame.lines.find((line) => line.spans.some((span) => span.text.includes("Allow")))
    const dot = rule?.spans.find((span) => span.text.includes("●"))
    const legendDot = legend?.spans.find((span) => span.text.includes("●"))
    if (!dot || !legendDot) throw new Error("Expected rendered rule and legend dots")
    expect(view.ctx().theme.theme.success.r).toBe(view.ctx().theme.theme.success.g)
    expect(dot.fg.g).toBeGreaterThan(dot.fg.r)
    expect(dot.fg.g).toBeGreaterThan(dot.fg.b)
    expect(dot.fg.toInts()).toEqual(legendDot.fg.toInts())
    const selection = rule?.spans.find((span) => span.text.includes("›"))
    expect(selection?.fg.toInts()).not.toEqual(dot.fg.toInts())
    view.app.mockInput.pressEnter()
    await view.app.waitForFrame((frame) => frame.includes("enter save"))
    const chooser = view.app.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes("allow")))
    expect(chooser?.spans.find((span) => span.text.includes("●"))?.fg.toInts()).toEqual(dot.fg.toInts())
    view.app.mockInput.pressBackspace()
    await view.app.waitForFrame((frame) => frame.includes("3 rules"))
  }
})

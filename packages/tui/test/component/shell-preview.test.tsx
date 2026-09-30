/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { expect, test } from "bun:test"
import { createMemo, onCleanup, Show } from "solid-js"
import { TuiConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider } from "../../src/context/clipboard"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { LocationProvider } from "../../src/context/location"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider, useRoute } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { ShellTool } from "../../src/routes/session"
import { Shell } from "../../src/routes/shell"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory } from "../fixture/tui-sdk"

function shellPart(output: string, shellStatus = "running", background = true): ToolPart {
  return {
    id: "shell-part",
    messageID: "child-message",
    sessionID: "child",
    callID: "shell-call",
    type: "tool",
    tool: "bash",
    state: {
      status: "completed",
      title: "Live shell",
      input: { command: "run live logs" },
      output: "Job started",
      time: { start: 1, end: 2 },
      metadata: { background, output, shellStatus, jobId: "live-job", outputPath: "/tmp/live.log" },
    },
  }
}

async function mount(root: string, initial: ToolPart) {
  const events = createEventSource()
  const disposals: Promise<void>[] = []
  let route: ReturnType<typeof useRoute> | undefined
  let sync: ReturnType<typeof useSync> | undefined
  function View() {
    route = useRoute()
    sync = useSync()
    const data = sync
    const currentRoute = route
    const part = createMemo(() => {
      const value = data.data.part[initial.messageID]?.find((part) => part.id === initial.id)
      return value?.type === "tool" ? value : initial
    })
    const metadata = createMemo(() => {
      const state = part().state
      return state.status === "pending" ? {} : (state.metadata ?? {})
    })
    return (
      <Show when={data.ready}>
        <Show
          when={currentRoute.data.type === "session" && currentRoute.data.shell}
          fallback={
            <box>
              <text>Main transcript</text>
              <ShellTool
                part={part()}
                tool="bash"
                input={part().state.input}
                metadata={metadata()}
                width={116}
                sessionID="parent"
              />
            </box>
          }
        >
          <Shell />
        </Show>
      </Show>
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
        paths={{ state: root, home: root }}
        onDispose={(done) => disposals.push(done)}
      >
        <ArgsProvider>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <ClipboardProvider value={{}}>
                      <SDKProvider
                        url="http://test"
                        directory={directory}
                        fetch={createFetch().fetch}
                        events={events.source}
                      >
                        <PermissionProvider>
                          <ProjectProvider>
                            <ExitProvider exit={() => {}}>
                              <SyncProvider>
                                <RouteProvider initialRoute={{ type: "session", sessionID: "parent" }}>
                                  <LocationProvider>
                                    <DialogProvider>
                                      <View />
                                    </DialogProvider>
                                  </LocationProvider>
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
  const frame = async (predicate: (text: string) => boolean) => {
    const deadline = Date.now() + 3000
    while (true) {
      await app.renderOnce()
      const text = app.captureCharFrame()
      if (predicate(text)) return text
      if (Date.now() > deadline) throw new Error(`Timed out waiting for shell preview:\n${text}`)
      await Bun.sleep(10)
    }
  }
  const update = (part: ToolPart) =>
    events.emit({
      directory,
      payload: {
        id: `updated-${Date.now()}`,
        type: "message.part.updated",
        properties: { sessionID: part.sessionID, part, time: Date.now() },
      },
    })
  await frame((text) => text.includes("Main transcript"))
  update(initial)
  return {
    app,
    frame,
    update,
    route: () => route?.data,
    async click(label: string) {
      const lines = (await frame((text) => text.includes(label))).split("\n")
      const y = lines.findIndex((line) => line.includes(label))
      await app.mockMouse.click(lines[y].indexOf(label) + 1, y)
    },
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      await Promise.all(disposals)
    },
  }
}

test("background shell boxes show a live ten-line tail and open the full output on click", async () => {
  await using tmp = await tmpdir()
  const output = Array.from({ length: 25 }, (_, index) => `log line ${String(index).padStart(2, "0")}`).join("\n")
  await using view = await mount(tmp.path, shellPart(output))
  const first = await view.frame((text) => text.includes("log line 24"))
  expect(first).toContain("log line 15")
  expect(first).not.toContain("log line 14")
  expect(first).not.toContain("log line 00")
  expect(first.match(/log line \d+/g)).toHaveLength(10)
  expect(first).toContain("Click to open shell")
  view.update(shellPart(`${output}\nlog line 25`))
  const latest = await view.frame((text) => text.includes("log line 25"))
  expect(latest).not.toContain("log line 15")
  expect(latest.match(/log line \d+/g)).toHaveLength(10)
  await view.click("log line 25")
  view.app.mockInput.pressKey("HOME")
  const full = await view.frame((text) => text.includes("log line 00"))
  expect(full).not.toContain("Main transcript")
  expect(full).toContain("log line 25")
  expect(view.route()).toEqual({
    type: "session",
    sessionID: "child",
    shell: { messageID: "child-message", partID: "shell-part", returnSessionID: "parent" },
  })
  view.app.mockInput.pressArrow("up")
  await view.frame((text) => text.includes("Main transcript"))
  expect(view.route()).toEqual({ type: "session", sessionID: "parent" })
})

test("completed short background shell boxes remain clickable", async () => {
  await using tmp = await tmpdir()
  await using view = await mount(tmp.path, shellPart("Done successfully", "exited"))
  const preview = await view.frame((text) => text.includes("Done successfully"))
  expect(preview).toContain("Background shell · exited")
  expect(preview).not.toContain("Latest output")
  await view.click("run live logs")
  await view.frame((text) => text.includes("Shell · exited"))
  expect(view.route()).toMatchObject({ sessionID: "child", shell: { returnSessionID: "parent" } })
})

test("foreground shells retain their head preview and inline expansion", async () => {
  await using tmp = await tmpdir()
  const output = Array.from({ length: 25 }, (_, index) => `log line ${String(index).padStart(2, "0")}`).join("\n")
  await using view = await mount(tmp.path, shellPart(output, "exited", false))
  const preview = await view.frame((text) => text.includes("Click to expand"))
  expect(preview).toContain("log line 00")
  expect(preview).not.toContain("log line 24")
  await view.click("Click to expand")
  const expanded = await view.frame((text) => text.includes("log line 24"))
  expect(expanded).toContain("Main transcript")
  expect(expanded).toContain("Click to collapse")
  expect(view.route()).toEqual({ type: "session", sessionID: "parent" })
})

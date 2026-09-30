/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { SidebarFooterView } from "../../../src/feature-plugins/sidebar/footer"
import { ArgsProvider } from "../../../src/context/args"
import { TuiConfigProvider } from "../../../src/config"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"
import { tmpdir } from "../../fixture/fixture"

test("sidebar footer totals changes for the current session beside the path", async () => {
  await using tmp = await tmpdir()
  const events = createEventSource()
  const calls = createFetch()
  const [files, setFiles] = createSignal([{ file: "a.ts", additions: 4, deletions: 3 }])
  const color = RGBA.fromHex("#ffffff")
  const api = {
    theme: {
      current: { text: color, textMuted: color, success: color, diffAdded: color, diffRemoved: color },
    },
    state: {
      provider: [],
      session: {
        get: () => ({ directory: "/home/test/my-app" }),
        diff: (sessionID: string) => (sessionID === "current" ? files() : [{ additions: 100, deletions: 100 }]),
      },
      path: { directory: "/home/test/my-app" },
      vcs: {},
    },
    kv: { get: () => true },
    app: { version: "test" },
  } as unknown as TuiPluginApi
  function Harness() {
    const config = createTuiResolvedConfig({ theme: "opencode" })
    return (
      <TestTuiContexts directory={directory} paths={{ state: tmp.path, home: "/home/test", worktree: tmp.path }}>
        <ArgsProvider>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                  <PermissionProvider>
                    <ProjectProvider>
                      <ExitProvider exit={() => {}}>
                        <SyncProvider>
                          <box width={38}>
                            <SidebarFooterView api={api} sessionID="current" />
                          </box>
                        </SyncProvider>
                      </ExitProvider>
                    </ProjectProvider>
                  </PermissionProvider>
                </SDKProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </ArgsProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width: 42, height: 4 })

  try {
    const deadline = Date.now() + 2000
    while (!app.captureCharFrame().includes("~/my-app") && Date.now() < deadline) {
      await app.renderOnce()
      await Bun.sleep(10)
    }
    expect(app.captureCharFrame()).toContain("~/my-app")
    expect(app.captureCharFrame()).toContain("+4 -3")

    setFiles([{ file: "b.ts", additions: 2, deletions: 0 }])
    await app.flush()
    expect(app.captureCharFrame()).toContain("+2")
    expect(app.captureCharFrame()).not.toContain("-3")
  } finally {
    app.renderer.destroy()
  }
})

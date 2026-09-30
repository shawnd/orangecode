/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { DialogUsageStats } from "../../src/component/dialog-usage-stats"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ProjectProvider, useProject } from "../../src/context/project"
import { RouteProvider } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createFetch, directory, eventSource, json } from "../fixture/tui-sdk"

test("usage arrows keep hierarchy and time independent, and Tab no longer changes scope", async () => {
  await using tmp = await tmpdir()
  const tokens = { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }
  const requests: URL[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/project/proj_test/directories") return json([])
    if (url.pathname !== "/api/session/usage") return
    requests.push(url)
    const factor = url.searchParams.has("start") ? 0.5 : 1
    return json({
      data: {
        all: { sessions: 3, cost: 31 * factor, tokens },
        project: { sessions: 2, cost: 23 * factor, tokens },
        session: { sessions: 1, cost: 19 * factor, tokens },
      },
    })
  })
  function Usage() {
    void useProject().sync()
    return <DialogUsageStats />
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ theme: "opencode" })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={directory} paths={{ state: tmp.path, home: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={eventSource()}>
                    <ProjectProvider>
                      <RouteProvider initialRoute={{ type: "session", sessionID: "current" }}>
                        <DialogProvider>
                          <Usage />
                        </DialogProvider>
                      </RouteProvider>
                    </ProjectProvider>
                  </SDKProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width: 100, height: 45 })
  async function cost(value: string) {
    const deadline = Date.now() + 3000
    for (;;) {
      await app.renderOnce()
      if (app.captureCharFrame().split("TOKENS BY TYPE")[0].includes(`$${value}`)) return
      if (Date.now() > deadline) throw new Error(`Expected cost $${value}:\n${app.captureCharFrame()}`)
      await Bun.sleep(10)
    }
  }
  try {
    await cost("19.00")
    const loaded = requests.length
    expect(loaded).toBeGreaterThan(0)
    await app.mockInput.pressKey("TAB")
    await cost("19.00")
    await app.mockInput.pressArrow("left")
    await cost("23.00")
    await app.mockInput.pressArrow("up")
    await cost("11.50")
    expect(requests).toHaveLength(loaded + 1)
    await app.mockInput.pressArrow("left")
    await cost("15.50")
    await app.mockInput.pressArrow("right")
    await app.mockInput.pressArrow("right")
    await cost("9.50")
    await app.mockInput.pressArrow("down")
    await cost("19.00")
    await app.mockInput.pressArrow("up")
    await cost("9.50")
    expect(requests).toHaveLength(loaded + 1)
    await app.mockInput.pressArrow("down")
    await cost("19.00")
    await app.mockInput.pressArrow("down")
    await cost("9.50")
    expect(requests).toHaveLength(loaded + 2)
    await app.mockInput.pressArrow("up")
    await cost("19.00")
    await app.mockInput.pressArrow("down")
    await cost("9.50")
    expect(requests).toHaveLength(loaded + 2)
    expect(app.captureCharFrame()).toContain("tab switches control")
  } finally {
    app.renderer.destroy()
  }
})

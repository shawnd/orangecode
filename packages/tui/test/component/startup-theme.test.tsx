import { expect, test } from "bun:test"
import { CliRenderEvents, type TerminalColors } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createEffect, onMount } from "solid-js"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { tmpdir } from "../fixture/fixture"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider, useTheme } from "../../src/context/theme"
import { setSystemTheme } from "../../src/theme"
import { flushStartupPresentation } from "../../src/startup/cache"

test("system startup stays transparent after palette timeout and accepts a later palette", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  setSystemTheme(undefined)
  const ready = Promise.withResolvers<ReturnType<typeof useTheme>>()
  const disposals = new Set<Promise<void>>()
  const backgrounds: number[] = []
  function Probe() {
    const theme = useTheme()
    createEffect(() => backgrounds.push(theme.theme.background.a))
    onMount(() => ready.resolve(theme))
    return (
      <box width="100%" height="100%" backgroundColor={theme.theme.background}>
        <text>ready</text>
      </box>
    )
  }
  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: tmp.path }} onDispose={(done) => disposals.add(done)}>
        <TuiConfigProvider config={createTuiResolvedConfig({ theme: "system" })}>
          <KVProvider>
            <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
              <Probe />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 10 },
  )
  try {
    // The real test renderer gets no terminal palette replies on startup.
    const theme = await ready.promise
    expect(theme.selected).toBe("system")
    expect(theme.theme.background.a).toBe(0)
    await app.renderOnce()
    expect(app.captureSpans().lines[0].spans[0].bg.a).toBe(0)

    const colors: TerminalColors = {
      palette: ["#151515", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6"],
      defaultForeground: "#a9b1d6",
      defaultBackground: "#1a1b26",
      cursorColor: null,
      mouseForeground: null,
      mouseBackground: null,
      tekForeground: null,
      tekBackground: null,
      highlightBackground: null,
      highlightForeground: null,
    }
    app.renderer.emit(CliRenderEvents.PALETTE, colors)
    await app.renderOnce()
    expect(theme.selected).toBe("system")
    expect(theme.theme.text.toInts()).toEqual([169, 177, 214, 255])
    expect(theme.theme.background.toInts()).toEqual([26, 27, 38, 0])
    expect(backgrounds.every((alpha) => alpha === 0)).toBe(true)
    expect(app.captureSpans().lines[0].spans[0].bg.a).toBe(0)
    expect(app.getNativeStats().cellsUpdated).toBe(0)

    app.renderer.emit(CliRenderEvents.PALETTE, { ...colors, palette: [], defaultBackground: "#222222" })
    expect(theme.theme.background.toInts()).toEqual([34, 34, 34, 0])
    await app.renderOnce()
    expect(app.getNativeStats().cellsUpdated).toBe(0)

    theme.set("opencode")
    expect(theme.theme.background.a).toBe(1)
    await app.renderOnce()
    expect(app.captureSpans().lines[0].spans[0].bg.toInts()).toEqual([10, 10, 10, 255])
    expect(app.getNativeStats().cellsUpdated).toBe(400)
  } finally {
    app.renderer.destroy()
    await Promise.all(disposals)
    await flushStartupPresentation(tmp.path)
    setSystemTheme(undefined)
  }
})

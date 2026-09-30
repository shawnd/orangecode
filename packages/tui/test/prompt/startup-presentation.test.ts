import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { startupPresentation } from "../../src/startup/presentation"
import { readStartupPresentation } from "../../src/startup/read-presentation"
import { cacheStartupPresentation } from "../../src/startup/cache"

test("presentation cache is bounded, validated, XDG-scoped and contains display data only", async () => {
  const root = await mkdtemp(`${tmpdir()}/startup-presentation-`)
  const state = `${root}/opencode`
  const file = `${state}/startup-presentation.json`
  const read = () => readStartupPresentation(startupPresentation, { XDG_STATE_HOME: root })
  try {
    expect(read()).toEqual(startupPresentation())
    await mkdir(state)
    for (const invalid of [
      "{",
      "null",
      JSON.stringify({ ...startupPresentation(), version: 2 }),
      JSON.stringify({ ...startupPresentation(), text: "\x1b[2J" }),
      JSON.stringify({ ...startupPresentation(), text: "transparent" }),
      JSON.stringify({ ...startupPresentation(), cursorStyle: "\x1b[2J" }),
      " ".repeat(4097),
      JSON.stringify({ ...startupPresentation(), padding: "x".repeat(32768) }),
    ]) {
      await Bun.write(file, invalid)
      expect(read()).toEqual(startupPresentation())
    }
    const theme = {
      ...startupPresentation(),
      background: "#fafafa",
      backgroundElement: "#eeeeee",
      text: "#101010",
      maxWidth: "auto" as const,
    }
    await Bun.write(file, JSON.stringify({ ...theme, draft: "must not be retained", sessionID: "secret" }))
    expect(read()).toEqual(theme)
    await rm(file)
    await mkdir(file)
    expect(read()).toEqual(startupPresentation())
    await rm(file, { recursive: true })
    if (process.platform !== "win32") {
      const fifo = Bun.spawn(["mkfifo", file])
      expect(await fifo.exited).toBe(0)
      expect(read()).toEqual(startupPresentation())
      await rm(file)
    }
    // Metadata arriving before ThemeProvider is ready must not replace a saved
    // custom theme with the default palette during a short/failed startup.
    await Bun.write(file, JSON.stringify(theme))
    cacheStartupPresentation(state, { border: "#123456" })
    await Bun.sleep(150)
    expect(read()).toEqual(theme)
    cacheStartupPresentation(state, theme)
    cacheStartupPresentation(state, { textMuted: "#777777", bottomHeight: 3 })
    const deadline = Date.now() + 2000
    while (read().textMuted !== "#777777" && Date.now() < deadline) await Bun.sleep(10)
    expect(read()).toEqual({ ...theme, textMuted: "#777777", bottomHeight: 3 })
    expect(Object.keys(await Bun.file(file).json()).sort()).toEqual(
      Object.entries(startupPresentation())
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .sort(),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("cached selection is directory-scoped, bounded and cannot inject terminal control sequences", async () => {
  const root = await mkdtemp(`${tmpdir()}/startup-selection-`)
  const state = `${root}/opencode`
  const file = `${state}/startup-presentation.json`
  const selection = {
    directory: "/projects/one",
    agent: "Plan",
    model: "Example Model",
    provider: "Example Provider",
    variant: "high",
  }
  try {
    await mkdir(state)
    await Bun.write(file, JSON.stringify({ ...startupPresentation(), selection: { ...selection, secret: "discard" } }))
    expect(
      readStartupPresentation(startupPresentation, { XDG_STATE_HOME: root }, selection.directory).selection,
    ).toEqual(selection)
    expect(
      readStartupPresentation(startupPresentation, { XDG_STATE_HOME: root }, "/projects/two").selection,
    ).toBeUndefined()
    for (const model of ["\x1b[2J", "line\nbreak", "bad\x9b2J", "x".repeat(129)]) {
      await Bun.write(
        file,
        JSON.stringify({ ...startupPresentation(), text: "#123456", selection: { ...selection, model } }),
      )
      const cached = readStartupPresentation(startupPresentation, { XDG_STATE_HOME: root }, selection.directory)
      expect(cached.selection).toBeUndefined()
      expect(cached.text).toBe("#123456")
    }
    cacheStartupPresentation(state, { ...startupPresentation(), selection })
    const deadline = Date.now() + 2000
    while (
      !readStartupPresentation(startupPresentation, { XDG_STATE_HOME: root }, selection.directory).selection &&
      Date.now() < deadline
    )
      await Bun.sleep(10)
    expect(
      readStartupPresentation(startupPresentation, { XDG_STATE_HOME: root }, selection.directory).selection,
    ).toEqual(selection)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("slash snapshots retain only safe directory-scoped display data and action identities", async () => {
  const root = await mkdtemp(`${tmpdir()}/startup-slashes-`)
  try {
    await mkdir(`${root}/opencode`)
    await Bun.write(
      `${root}/opencode/startup-presentation.json`,
      JSON.stringify({
        ...startupPresentation(),
        slashes: {
          directory: "/project",
          items: [
            { display: "/models", command: "model.list", description: "Switch model", onSelect: "discard" },
            { display: "/review:mcp", value: "/review", description: "Review changes", template: "discard" },
            { display: "/unsafe\x1b[2J", command: "bad" },
          ],
        },
      }),
    )
    const read = (directory: string) =>
      readStartupPresentation(startupPresentation, { XDG_STATE_HOME: root }, directory)
    expect(read("/project").slashes?.items).toEqual([
      { display: "/models", command: "model.list", description: "Switch model" },
      { display: "/review:mcp", value: "/review", description: "Review changes" },
    ])
    expect(read("/other").slashes).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("resolving the default palette replaces an older theme even when metadata equals the fallback", async () => {
  const root = await mkdtemp(`${tmpdir()}/startup-default-`)
  const state = `${root}/opencode`
  const file = `${state}/startup-presentation.json`
  try {
    await mkdir(state)
    await Bun.write(file, JSON.stringify({ ...startupPresentation(), background: "#abcdef" }))
    cacheStartupPresentation(state, { border: startupPresentation().border })
    cacheStartupPresentation(state, startupPresentation())
    const deadline = Date.now() + 2000
    while ((await Bun.file(file).json()).background !== startupPresentation().background && Date.now() < deadline)
      await Bun.sleep(10)
    expect(await Bun.file(file).json()).toEqual(startupPresentation())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

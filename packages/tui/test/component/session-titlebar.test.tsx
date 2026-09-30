import { expect, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { BoxRenderable, InputRenderable, RGBA, TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createSignal, onCleanup, onMount } from "solid-js"
import { TitlebarContent } from "../../src/routes/session/titlebar"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useBindings } from "../../src/keymap"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const theme = {
  text: RGBA.fromHex("#ffffff"),
  textMuted: RGBA.fromHex("#888888"),
  backgroundPanel: RGBA.fromHex("#222222"),
}
const sessionID = "ses_123456789012345678901234567890"

test("session titlebar truncates Unicode titles and keeps the copyable short ID right-aligned on resize", async () => {
  const [width, setWidth] = createSignal(80)
  const [title, setTitle] = createSignal("👩‍💻界é".repeat(40))
  const copied: string[] = []
  const app = await testRender(
    () => (
      <TitlebarContent
        sessionID={sessionID}
        title={title()}
        width={width()}
        theme={theme}
        onCopy={() => copied.push(sessionID)}
        onRename={() => {}}
      />
    ),
    { width: 80, height: 5, useThread: false },
  )
  try {
    await app.renderOnce()
    const line = app.captureCharFrame().split("\n")[0]
    expect(line).toContain("…")
    expect(line.trimEnd().endsWith("ses_12345…")).toBe(true)
    expect(line).not.toContain("�")
    expect(Bun.stringWidth(line.slice(0, line.indexOf("ses_")))).toBe(70)
    // Mouse coordinates are terminal columns, rather than string offsets.
    await app.mockMouse.click(Bun.stringWidth(line.slice(0, line.indexOf("ses_"))) + 2, 0)
    expect(copied).toEqual([sessionID])

    setWidth(30)
    app.resize(30, 5)
    await app.renderOnce()
    const narrow = app.captureCharFrame().split("\n")
    expect(narrow[0]).toContain("…")
    expect(Bun.stringWidth(narrow[0].slice(0, narrow[0].indexOf("ses_")))).toBe(20)
    expect(narrow[0]).not.toContain("tokens")
    expect(narrow.slice(1).every((line) => !line.trim())).toBe(true)

    setTitle("👩‍💻界é")
    setWidth(40)
    app.resize(40, 5)
    await app.renderOnce()
    const full = app.captureCharFrame().split("\n")[0]
    expect(full.startsWith("👩‍💻界é")).toBe(true)
    expect(full.trimEnd().endsWith(sessionID)).toBe(true)
    expect(full).not.toContain("…")

    setWidth(39)
    app.resize(39, 5)
    await app.renderOnce()
    const compact = app.captureCharFrame().split("\n")[0]
    expect(compact.startsWith("👩‍💻界é")).toBe(true)
    expect(compact.trimEnd().endsWith("ses_12345…")).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("clicking the title shows a full-width, multi-row overlay for one second without moving content", async () => {
  const title = "A long chat title that needs several rows to reveal the whole thing and its final words"
  const below: { box?: BoxRenderable } = {}
  const app = await testRender(
    () => (
      <box>
        <TitlebarContent
          sessionID={sessionID}
          title={title}
          width={40}
          theme={theme}
          onCopy={() => {}}
          onRename={() => {}}
        />
        <box ref={(box) => (below.box = box)}>
          <text>Content below the titlebar</text>
        </box>
      </box>
    ),
    { width: 40, height: 8, useThread: false },
  )
  try {
    await app.renderOnce()
    const original = app.captureCharFrame()
    expect(original.split("\n")[0]).toContain("…")
    expect(original.split("\n")[0].trimEnd().endsWith("ses_12345…")).toBe(true)
    expect(below.box?.y).toBe(1)

    await app.mockMouse.click(2, 0)
    await app.renderOnce()
    await app.renderOnce()
    const expanded = app.captureCharFrame()
    expect(expanded).not.toContain("ses_12345")
    expect(expanded).not.toContain("Content below")
    expect(
      expanded
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" "),
    ).toBe(title)
    expect(below.box?.y).toBe(1)

    await Bun.sleep(1100)
    await app.renderOnce()
    expect(app.captureCharFrame()).toBe(original)
    expect(below.box?.y).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("double-click rename supports all cursor controls, confirms once, cancels, and restores prompt focus", async () => {
  const renamed: string[] = []
  const [title, setTitle] = createSignal("Original chat title")
  const [prompt, setPrompt] = createSignal<TextareaRenderable>()
  let submitted = 0
  function Body() {
    useBindings(() => ({
      target: prompt,
      mode: "base",
      bindings: [{ key: "return", cmd: () => submitted++ }],
    }))
    onMount(() => prompt()?.focus())
    return (
      <box>
        <TitlebarContent
          sessionID={sessionID}
          title={title()}
          width={40}
          theme={theme}
          onCopy={() => {}}
          onRename={(value) => {
            renamed.push(value)
            setTitle(value)
          }}
        />
        <textarea ref={setPrompt} height={1} initialValue="Untouched prompt" />
      </box>
    )
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    onCleanup(registerOpencodeKeymap(keymap, renderer, createTuiResolvedConfig()))
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <Body />
      </OpencodeKeymapProvider>
    )
  }
  const app = await testRender(() => <Harness />, { width: 40, height: 8, useThread: false })
  try {
    await app.renderOnce()
    expect(app.renderer.currentFocusedRenderable === prompt()).toBe(true)
    await app.mockMouse.click(2, 0)
    await app.renderOnce()
    await app.mockMouse.click(2, 0)
    await app.renderOnce()
    const input = app.renderer.currentFocusedRenderable
    expect(input instanceof InputRenderable).toBe(true)
    if (!(input instanceof InputRenderable)) throw new Error("Rename input is not focused")
    expect(input.value).toBe(title())
    expect(input.cursorOffset).toBe(title().length)
    expect(app.captureCharFrame()).not.toContain("ses_12345")

    app.mockInput.pressArrow("up")
    expect(input.cursorOffset).toBe(0)
    app.mockInput.pressArrow("right")
    expect(input.cursorOffset).toBe(1)
    app.mockInput.pressArrow("left")
    expect(input.cursorOffset).toBe(0)
    app.mockInput.pressArrow("down")
    expect(input.cursorOffset).toBe(title().length)
    app.mockInput.pressKey("HOME")
    expect(input.cursorOffset).toBe(0)
    app.mockInput.pressKey("END")
    expect(input.cursorOffset).toBe(title().length)
    await app.mockInput.typeText(" renamed")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(renamed).toEqual(["Original chat title renamed"])
    expect(submitted).toBe(0)
    expect(app.renderer.currentFocusedRenderable === prompt()).toBe(true)

    await app.mockMouse.click(2, 0)
    await app.renderOnce()
    await app.mockMouse.click(2, 0)
    await app.renderOnce()
    await app.mockInput.typeText(" cancelled")
    app.mockInput.pressEscape()
    await Bun.sleep(50)
    await app.renderOnce()
    expect(renamed).toEqual(["Original chat title renamed"])
    expect(title()).toBe("Original chat title renamed")
    expect(prompt()?.plainText).toBe("Untouched prompt")
    expect(app.renderer.currentFocusedRenderable === prompt()).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

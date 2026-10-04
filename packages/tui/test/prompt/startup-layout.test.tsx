import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { EarlyPrompt } from "../../src/component/early-prompt"
import { homeGeometry, homeInputHeight, homePromptWidth, startupPresentation } from "../../src/startup/presentation"
import { startupDraft } from "../../src/startup/draft"
import { promptOffsetWidth } from "../../src/prompt/display"
import { builtinStartupSlashes, createStartupSlashes, type StartupSlashDraft } from "../../src/startup/slashes"

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

test("startup slash popup uses the live menu layout and supports mouse selection", async () => {
  const theme = startupPresentation()
  const draft: StartupSlashDraft = { text: "/mo", cursor: 3 }
  const slashes = createStartupSlashes(builtinStartupSlashes())
  let update = () => {}
  const app = await testRender(
    () => (
      <EarlyPrompt
        input={{
          active: true,
          presentation: theme,
          read: () => ({ ...draft }),
          completion: (height) => slashes.view(draft, height),
          selectCompletion(index) {
            slashes.select(draft, index)
            update()
          },
          subscribe(listener) {
            update = listener
            return () => {}
          },
          takeover: async () => process.stdin,
          onCancel() {},
          claim: () => undefined,
          dispose() {},
        }}
      />
    ),
    { width: 120, height: 40, useThread: false },
  )
  try {
    await app.renderOnce()
    await app.renderOnce()
    const layout = homeGeometry(120, 40, homePromptWidth(120), 1)
    const top = layout.promptTop - (slashes.view(draft, layout.promptTop)?.height ?? 1)
    const lines = app.captureCharFrame().split("\n")
    expect(lines[top]).toContain("/models")
    expect(lines[top]).toContain("Switch model")
    expect(lines[top].indexOf("/models")).toBe(layout.left + 2)
    await app.mockMouse.click(layout.left + 4, top)
    await app.renderOnce()
    expect(draft.text).toBe("/models ")
    expect(draft.command?.name).toBe("model.list")
    expect(app.captureCharFrame()).toContain("Opening /models when ready")
  } finally {
    app.renderer.destroy()
  }
})

test("late input notifications and resize cannot read the destroyed startup textarea after handoff", async () => {
  const draft: StartupSlashDraft = { text: "/", cursor: 1 }
  const slashes = createStartupSlashes(builtinStartupSlashes())
  let active = true
  let notify = () => {}
  let stopped = 0
  const app = await testRender(
    () => (
      <EarlyPrompt
        input={{
          get active() {
            return active
          },
          presentation: startupPresentation(),
          read: () => ({ ...draft }),
          completion: (height) => slashes.view(draft, height),
          subscribe(listener) {
            notify = listener
            return () => {
              stopped++
            }
          },
          takeover: async () => process.stdin,
          onCancel() {},
          claim: () => undefined,
          dispose() {},
        }}
      />
    ),
    { width: 120, height: 40, useThread: false },
  )
  try {
    await app.renderOnce()
    const old = textarea(app.renderer.root)
    const late = notify
    active = false
    notify()
    await app.renderOnce()
    await new Promise<void>((resolve) => process.nextTick(resolve))
    expect(old?.isDestroyed).toBe(true)
    expect(() => late()).not.toThrow()
    app.resize(80, 24)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("/models")
    expect(stopped).toBe(1)
  } finally {
    app.renderer.destroy()
  }
  expect(stopped).toBe(1)
})

test("ANSI draft projection agrees with native word wrapping, tabs, Unicode and every cursor boundary", async () => {
  const app = await createTestRenderer({ width: 80, height: 40, useThread: false })
  const input = new TextareaRenderable(app.renderer, { width: 10, minHeight: 1, maxHeight: 40 })
  app.renderer.root.add(input)
  try {
    for (const width of [6, 10, 25, 70]) {
      input.width = width
      for (const text of [
        "",
        "abc def ghi jkl",
        "abcdefghijkl",
        "a\tb",
        "aa\tb",
        "界\tb",
        "foo-bar-baz-bar",
        "abc     defg",
        "👩‍💻界abcdef界def",
        "ab/1234567890",
        "ab.cdefghijk",
        "abc\tdefghijk",
        "one\ntwo\n",
        "é👩‍💻界\tend",
        ...Array.from(":;!?/\\.,-_=+()[]{}'\"@#$%^&*<>|~`é界").map((char) => `ab${char}cdefghijkl`),
        "ab👩‍💻cdefghijkl",
      ]) {
        input.setText(text)
        await app.renderOnce()
        for (const cursor of [...Array.from(segmenter.segment(text), (part) => part.index), text.length]) {
          input.cursorOffset = promptOffsetWidth(text.slice(0, cursor))
          const projected = startupDraft(text, cursor, width, segmenter)
          expect({
            text,
            width,
            cursor,
            row: projected.cursor.row,
            column: projected.cursor.column,
            rows: projected.rows.length,
          }).toEqual({
            text,
            width,
            cursor,
            row: input.visualCursor.visualRow,
            column: input.visualCursor.visualCol,
            rows: input.virtualLineCount,
          })
        }
      }
    }
  } finally {
    app.renderer.destroy()
  }
})

function textarea(root: Renderable): TextareaRenderable | undefined {
  if (root instanceof TextareaRenderable) return root
  for (const child of root.getChildren()) {
    const found = textarea(child)
    if (found) return found
  }
}

test("ANSI geometry matches the shared native home frame across terminal sizes, wraps and resize", async () => {
  const theme = startupPresentation()
  theme.selection = {
    directory: "/project",
    agent: "Plan",
    model: "Cached Model",
    provider: "Provider",
    variant: "high",
  }
  let draft = { text: "VISUAL_MARK", cursor: 11 }
  let update = () => {}
  const app = await testRender(
    () => (
      <EarlyPrompt
        input={{
          active: true,
          presentation: theme,
          location: { directory: "/project", displayDirectory: "/project", version: "test-version", auto: false },
          read: () => draft,
          subscribe(listener) {
            update = listener
            return () => {}
          },
          takeover: async () => process.stdin,
          onCancel() {},
          claim: () => undefined,
          dispose() {},
        }}
      />
    ),
    { width: 120, height: 40, useThread: false },
  )
  try {
    for (const [width, height] of [
      [120, 40],
      [80, 24],
      [60, 18],
      [40, 16],
      [120, 40],
    ]) {
      app.resize(width, height)
      for (const text of ["VISUAL_MARK", "VISUALone\nVISUALtwo\nVISUALthree", "word ".repeat(30), "界\t👩‍💻\nlast"]) {
        draft = { text, cursor: text.length }
        update()
        await app.renderOnce()
        await app.renderOnce()
        if (width === 120 && height === 40) {
          const frame = app.captureCharFrame()
          expect(frame).toContain("Plan · Cached Model Provider · high")
          expect(frame).toContain("click mode/model/variant to change")
          expect(frame).toContain("/project")
          expect(frame).toContain("test-version")
        }
        const input = textarea(app.renderer.root)!
        const promptWidth = homePromptWidth(width, theme.maxWidth)
        const projection = startupDraft(text, text.length, promptWidth - 5, segmenter)
        const layout = homeGeometry(
          width,
          height,
          promptWidth,
          Math.min(projection.rows.length, homeInputHeight(height)),
        )
        expect({ width, height, text, x: input.x, y: input.y, inputWidth: input.width }).toEqual({
          width,
          height,
          text,
          x: layout.left + 3,
          y: layout.textTop,
          inputWidth: promptWidth - 5,
        })
      }
    }
  } finally {
    app.renderer.destroy()
  }
})

test("scrolled startup drafts retain the native viewport and cursor during handoff", async () => {
  const app = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const input = new TextareaRenderable(app.renderer, { width: 70, minHeight: 1, maxHeight: 8 })
  app.renderer.root.add(input)
  const text = Array.from({ length: 20 }, (_, index) => `line${String(index).padStart(2, "0")}`).join("\n")
  try {
    for (const row of [0, 6, 7, 8, 10, 19, 17, 7, 0]) {
      const offset = row * 7 + 3
      input.setText(text)
      input.cursorOffset = offset
      await app.renderOnce()
      const projected = startupDraft(text, offset, 70, segmenter, 8)
      expect(projected.top).toBe(input.scrollY)
      expect(projected.cursor.row - projected.top).toBe(input.visualCursor.visualRow)
      expect(projected.cursor.column).toBe(input.visualCursor.visualCol)
    }
  } finally {
    app.renderer.destroy()
  }
})

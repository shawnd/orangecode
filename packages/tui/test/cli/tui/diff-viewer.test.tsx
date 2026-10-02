/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import {
  CodeRenderable,
  DiffRenderable,
  LineNumberRenderable,
  MouseButton,
  type Renderable,
  ScrollBoxRenderable,
  TextareaRenderable,
} from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import type { TuiPluginApi, TuiPluginMeta, TuiRouteCurrent, TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import type { Session } from "@opencode-ai/sdk/v2"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { TuiKeybind } from "../../../src/config/keybind"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { onCleanup } from "solid-js"
import diffViewerPlugin from "../../../src/feature-plugins/system/diff-viewer"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { diffLineAt } from "../../../src/feature-plugins/system/diff-viewer-review"
import type { PromptInfo } from "../../../src/prompt/history"
import { tmpdir } from "../../fixture/fixture"

test("closing the diff viewer returns to the route it opened from", async () => {
  const viewer = await renderDiffViewer([])
  try {
    expect(viewer.current()).toEqual({
      name: "diff",
      params: { mode: "git", sessionID: "session-1", returnRoute: startRoute },
    })
    expect(viewer.vcsDiffInput()).toEqual({ directory: "/repo/session", mode: "git", context: 12 })

    expect(viewer.commands.has("diff.close")).toBe(true)
    viewer.commands.get("diff.close")!.run?.({} as never)
    expect(viewer.current()).toEqual(startRoute)
  } finally {
    await viewer.dispose()
  }
})

test("brackets navigate diff hunks", async () => {
  const viewer = await renderDiffViewer(
    [
      {
        file: "src/file.ts",
        additions: 3,
        deletions: 3,
        status: "modified",
        patch: `--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,3 @@
 const first = true
-const oldFirst = true
+const newFirst = true
 const afterFirst = true
@@ -20,3 +20,3 @@
 const second = true
-const oldSecond = true
+const newSecond = true
 const afterSecond = true
@@ -40,3 +40,3 @@
 const third = true
-const oldThird = true
+const newThird = true
 const afterThird = true`,
      },
    ],
    12,
  )
  try {
    await viewer.app.waitForFrame((frame) => frame.includes("const first"))
    await viewer.app.waitFor(() => Boolean(findScrollBox(viewer.app.renderer.root)))
    await viewer.app.flush()
    const scroll = findScrollBox(viewer.app.renderer.root)!
    const initial = scroll.scrollTop

    expect(TuiKeybind.defaultValue("diff_next_hunk")).toBe("]")
    expect(TuiKeybind.defaultValue("diff_previous_hunk")).toBe("[")

    viewer.commands.get("diff.next_hunk")!.run?.({} as never)
    await viewer.app.renderOnce()
    const first = scroll.scrollTop
    expect(first).toBeGreaterThan(initial)

    viewer.commands.get("diff.next_hunk")!.run?.({} as never)
    await viewer.app.renderOnce()
    const second = scroll.scrollTop
    expect(second).toBeGreaterThan(first)

    viewer.commands.get("diff.previous_hunk")!.run?.({} as never)
    await viewer.app.renderOnce()
    expect(scroll.scrollTop).toBe(first)

    viewer.commands.get("diff.next_hunk")!.run?.({} as never)
    await viewer.app.renderOnce()
    expect(scroll.scrollTop).toBe(second)

    scroll.scrollTo(initial)
    viewer.commands.get("diff.next_hunk")!.run?.({} as never)
    await viewer.app.renderOnce()
    expect(scroll.scrollTop).toBe(first)
  } finally {
    await viewer.dispose()
  }
})

const reviewPatch = {
  file: "src/review.txt",
  additions: 2,
  deletions: 2,
  status: "modified",
  patch:
    "--- a/src/review.txt\n+++ b/src/review.txt\n@@ -10,3 +20,3 @@\n context\n-old one\n-old two\n+new one\n+new two\n@@ -40 +50 @@\n-later old\n+later new",
}

const scrollPatch = {
  file: "scroll.txt",
  additions: 100,
  deletions: 0,
  status: "added",
  patch:
    "--- /dev/null\n+++ b/scroll.txt\n@@ -0,0 +1,100 @@\n" +
    Array.from({ length: 100 }, (_, index) => `+row${String(index + 1).padStart(3, "0")}`).join("\n"),
}

test("hunk shortcuts keep the destination header visible with a reserved selection gutter", async () => {
  const viewer = await renderDiffViewer(
    [
      {
        file: "wrap.txt",
        additions: 1,
        deletions: 1,
        status: "modified",
        patch:
          "--- a/wrap.txt\n+++ b/wrap.txt\n@@ -1,10 +1,10 @@\n" +
          Array.from({ length: 10 }, () => " " + "x".repeat(60)).join("\n") +
          "\n@@ -40 +40 @@\n-before\n+after\n@@ -80,20 +80,20 @@\n" +
          Array.from({ length: 20 }, (_, index) => ` tail ${index}`).join("\n"),
      },
    ],
    16,
    undefined,
    160,
  )
  try {
    await viewer.app.waitForFrame((frame) => frame.includes("xxxx"))
    const nodes = findDiffs(viewer.app.renderer.root)
    const pane = nodes[0].getChildren().find((node) => node instanceof LineNumberRenderable)!
    const code = pane.getChildren().find((node) => node instanceof CodeRenderable) as CodeRenderable
    viewer.app.resize(160 + (60 - code.width) * 2, 16)
    await viewer.app.flush()
    expect(code.width).toBe(60)
    const before = nodes[0].height
    await viewer.app.mockMouse.click(pane.x + 1, code.y)
    await viewer.app.flush()
    expect(nodes[0].height).toBe(before)
    viewer.app.mockInput.typeText("]")
    await viewer.app.flush()
    const scroll = findScrollBox(viewer.app.renderer.root)!
    expect(nodes[1].parent!.y).toBe(scroll.viewport.y)
    expect(viewer.app.captureCharFrame()).toContain("@@ -40 +40 @@")
    viewer.app.mockInput.typeText("[")
    await viewer.app.flush()
    expect(nodes[0].parent!.y).toBe(scroll.viewport.y)
  } finally {
    await viewer.dispose()
  }
})

test("mouse file and hunk headers fold independently and keyboard expansion restores them", async () => {
  const viewer = await renderDiffViewer([reviewPatch], 28)
  try {
    await viewer.app.waitForFrame((frame) => frame.includes("later new"))
    const clickText = async (text: string) => {
      const lines = viewer.app.captureCharFrame().split("\n")
      const row = lines.findIndex((line) => line.includes(text))
      expect(row).toBeGreaterThanOrEqual(0)
      await viewer.app.mockMouse.click(lines[row].indexOf(text), row)
      await viewer.app.renderOnce()
    }
    await clickText("@@ -10")
    expect(viewer.app.captureCharFrame()).not.toContain("new one")
    expect(viewer.app.captureCharFrame()).toContain("later new")
    viewer.commands.get("diff.expand")!.run?.({} as never)
    await viewer.app.waitForFrame((frame) => frame.includes("new one"))
    await clickText("src/review.txt")
    expect(viewer.app.captureCharFrame()).not.toContain("later new")
    viewer.commands.get("diff.expand_all")!.run?.({} as never)
    await viewer.app.waitForFrame((frame) => frame.includes("later new"))
  } finally {
    await viewer.dispose()
  }
})

test("keyboard collapse and expand keep targeting the selected hunk", async () => {
  const viewer = await renderDiffViewer([reviewPatch], 28)
  try {
    await viewer.app.waitForFrame((frame) => frame.includes("later new"))
    viewer.commands.get("diff.next_hunk")!.run?.({} as never)
    await viewer.app.renderOnce()
    viewer.commands.get("diff.collapse")!.run?.({} as never)
    await viewer.app.renderOnce()
    expect(viewer.app.captureCharFrame()).not.toContain("new one")
    expect(viewer.app.captureCharFrame()).toContain("later new")
    viewer.commands.get("diff.expand")!.run?.({} as never)
    await viewer.app.renderOnce()
    expect(viewer.app.captureCharFrame()).toContain("new one")
    viewer.commands.get("diff.collapse")!.run?.({} as never)
    await viewer.app.renderOnce()
    expect(viewer.app.captureCharFrame()).not.toContain("new one")
    expect(viewer.app.captureCharFrame()).toContain("later new")
  } finally {
    await viewer.dispose()
  }
})

test("clicking code in another hunk clears the previous annotation range", async () => {
  const viewer = await renderDiffViewer([reviewPatch], 28)
  try {
    await viewer.app.waitForFrame((frame) => frame.includes("later new"))
    const node = findDiff(viewer.app.renderer.root)!
    const pane = node.getChildren().find((node) => node instanceof LineNumberRenderable)!
    const code = pane.getChildren().find((node) => node instanceof CodeRenderable) as CodeRenderable
    await viewer.app.mockMouse.click(pane.x + 1, code.y + 1)
    await viewer.app.renderOnce()
    expect(viewer.app.captureCharFrame()).toContain("old lines 11–11")
    const lines = viewer.app.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes("later new"))
    await viewer.app.mockMouse.click(lines[row].indexOf("later new"), row)
    await viewer.app.renderOnce()
    expect(viewer.app.captureCharFrame()).not.toContain("old lines 11–11")
    viewer.commands.get("diff.annotate")!.run?.({} as never)
    await viewer.app.waitForFrame((frame) => frame.includes("src/review.txt:50 (new, working tree)"))
  } finally {
    await viewer.dispose()
  }
})

for (const width of [80, 160]) {
  test(`${width === 80 ? "unified" : "split"} selection movement never reflows code at the wrap boundary`, async () => {
    const viewer = await renderDiffViewer(
      [
        {
          file: "boundary.txt",
          additions: 2,
          deletions: 2,
          status: "modified",
          patch:
            "--- a/boundary.txt\n+++ b/boundary.txt\n@@ -1,4 +1,4 @@\n" +
            Array.from({ length: 2 }, () => " " + "x".repeat(60)).join("\n") +
            "\n-old one\n+new one\n-old two\n+new two\n@@ -20 +20 @@\n-before\n+after",
        },
      ],
      40,
      undefined,
      width,
    )
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("new two"))
      const nodes = findDiffs(viewer.app.renderer.root)
      const panes = nodes[0].getChildren().filter((node) => node instanceof LineNumberRenderable)
      const codes = panes.map(
        (pane) => pane.getChildren().find((node) => node instanceof CodeRenderable) as CodeRenderable,
      )
      viewer.app.resize(width + (60 - codes[0].width) * (width === 80 ? 1 : 2), 40)
      await viewer.app.flush()
      expect(codes[0].width).toBe(60)
      const geometry = () => ({
        code: codes.map((code) => ({ x: code.x, width: code.width, rows: [...code.lineInfo.lineSources] })),
        heights: nodes.map((node) => node.height),
        scroll: findScrollBox(viewer.app.renderer.root)!.scrollTop,
      })
      const before = geometry()
      const stable = async () => {
        for (let frame = 0; frame < 4; frame++) {
          await viewer.app.renderOnce()
          expect(geometry()).toEqual(before)
        }
      }
      // First selection, moves within a pane, and unified old/new transitions.
      viewer.app.mockInput.pressArrow("down")
      await stable()
      expect(viewer.app.captureCharFrame()).toContain(width === 80 ? "▶ old:3" : "▶ new:3")
      for (let move = 0; move < 3; move++) {
        viewer.app.mockInput.pressArrow("down")
        await stable()
      }
      const oldRow = codes[0].lineInfo.lineSources.findIndex((row) => panes[0].getLineNumbers().get(row) === 3)
      await viewer.app.mockMouse.click(codes[0].x + 1, codes[0].y + oldRow)
      await stable()
      const endRow = codes[0].lineInfo.lineSources.findIndex((row) => panes[0].getLineNumbers().get(row) === 4)
      await viewer.app.mockMouse.click(codes[0].x + 1, codes[0].y + endRow, MouseButton.LEFT, {
        modifiers: { shift: true },
      })
      await stable()
      expect(viewer.app.captureCharFrame()).toContain("▎")
      viewer.commands.get("diff.mark_reviewed")!.run?.({} as never)
      await stable()
      // Style rebuilds mutate sign/color maps in place. The cached highlight must
      // still refresh when OpenTUI replaces its source-number map.
      expect([...panes[0].getLineSigns().values()].some((sign) => sign.before === "▶")).toBe(true)
      expect([...panes[0].getLineSigns().values()].some((sign) => sign.before === "▎")).toBe(true)
      // Moving to another hunk must not release the previous gutter reservation.
      const nextPane = nodes[1].getChildren().find((node) => node instanceof LineNumberRenderable)!
      const nextCode = nextPane.getChildren().find((node) => node instanceof CodeRenderable) as CodeRenderable
      await viewer.app.mockMouse.click(nextCode.x + 1, nextCode.y)
      await stable()
    } finally {
      await viewer.dispose()
    }
  })

  test(`${width === 80 ? "unified" : "split"} held Kitty arrows repeat without terminal repeats and stop on release or a dialog`, async () => {
    const viewer = await renderDiffViewer([scrollPatch], 28, undefined, width, true)
    const current = () => Number(viewer.app.captureCharFrame().match(/▶ new:(\d+)/)?.[1])
    const down = () => viewer.app.mockInput.pressKey(width === 80 ? "\x1b[B" : "\x1b[57353;1u")
    const up = () => viewer.app.mockInput.pressKey(width === 80 ? "\x1b[A" : "\x1b[57352;1u")
    const releaseDown = () => viewer.app.mockInput.pressKey(width === 80 ? "\x1b[1;1:3B" : "\x1b[57353;1:3u")
    const releaseUp = () => viewer.app.mockInput.pressKey(width === 80 ? "\x1b[1;1:3A" : "\x1b[57352;1:3u")
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("row001"))
      if (width === 80) {
        viewer.app.mockInput.pressKey("\x1b[?7u")
        await viewer.app.renderOnce()
        expect(viewer.app.renderer.capabilities?.kitty_keyboard).toBe(true)
      }
      down()
      await viewer.app.renderOnce()
      expect(current()).toBe(1)
      await Bun.sleep(480)
      await viewer.app.renderOnce()
      expect(current()).toBeGreaterThan(1)
      releaseDown()
      await viewer.app.renderOnce()
      const released = current()
      await Bun.sleep(120)
      await viewer.app.renderOnce()
      expect(current()).toBe(released)
      down()
      viewer.app.mockInput.pressKey("\x1b[57353;1:2u".repeat(20))
      await viewer.app.renderOnce()
      const native = current()
      expect(native).toBe(released + 21)
      await Bun.sleep(480)
      await viewer.app.renderOnce()
      expect(current()).toBe(native)
      releaseDown()
      up()
      await viewer.app.renderOnce()
      const beforeUp = current()
      await Bun.sleep(480)
      await viewer.app.renderOnce()
      expect(current()).toBeLessThan(beforeUp)
      releaseUp()
      await viewer.app.renderOnce()
      const stopped = current()
      await Bun.sleep(120)
      await viewer.app.renderOnce()
      expect(current()).toBe(stopped)
      down()
      await viewer.app.renderOnce()
      const dialogLine = current()
      viewer.app.mockInput.typeText("a")
      await viewer.app.waitForFrame((frame) => frame.includes("Diff annotation"))
      await Bun.sleep(480)
      await viewer.app.renderOnce()
      expect(current()).toBe(dialogLine)
      releaseDown()
      viewer.app.mockInput.pressEscape()
    } finally {
      await viewer.dispose()
    }
  })

  test(`${width === 80 ? "unified" : "split"} arrows skip context by default and t enables all lines`, async () => {
    const viewer = await renderDiffViewer(
      [
        {
          file: "scope.txt",
          additions: 2,
          deletions: 2,
          status: "modified",
          patch:
            "--- a/scope.txt\n+++ b/scope.txt\n@@ -1,5 +1,5 @@\n first context\n-old one\n+new one\n between changes\n-old two\n+new two\n last context",
        },
      ],
      28,
      undefined,
      width,
    )
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("between changes"))
      expect(viewer.app.captureCharFrame()).toContain("changes only")
      viewer.app.mockInput.pressArrow("down")
      await viewer.app.renderOnce()
      expect(viewer.app.captureCharFrame()).toContain(width === 80 ? "▶ old:2" : "▶ new:2")
      viewer.app.mockInput.pressArrow("up")
      await viewer.app.renderOnce()
      expect(viewer.app.captureCharFrame()).not.toContain("▶ new:1")
      const clickContext = async () => {
        const lines = viewer.app.captureCharFrame().split("\n")
        const row = lines.findIndex((line) => line.includes("between changes"))
        await viewer.app.mockMouse.click(lines[row].lastIndexOf("between changes"), row)
        await viewer.app.renderOnce()
        expect(viewer.app.captureCharFrame()).toContain("▶ new:3")
      }
      await clickContext()
      viewer.app.mockInput.pressArrow("down")
      await viewer.app.renderOnce()
      expect(viewer.app.captureCharFrame()).toContain(width === 80 ? "▶ old:4" : "▶ new:4")
      viewer.app.mockInput.typeText("t")
      await viewer.app.renderOnce()
      expect(viewer.app.captureCharFrame()).toContain("all lines")
      viewer.app.mockInput.pressArrow("up")
      await viewer.app.renderOnce()
      expect(viewer.app.captureCharFrame()).toContain("▶ new:3")
      viewer.app.mockInput.typeText("t")
      await viewer.app.renderOnce()
      viewer.app.mockInput.pressArrow("up")
      await viewer.app.renderOnce()
      expect(viewer.app.captureCharFrame()).toContain("▶ new:2")
    } finally {
      await viewer.dispose()
    }
  })

  test(`held ${width === 80 ? "unified" : "split"} arrows move the active annotation line and keep it visible`, async () => {
    const viewer = await renderDiffViewer([scrollPatch], 14, undefined, width)
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("row001"))
      viewer.app.mockInput.pressArrow("down")
      await viewer.app.renderOnce()
      expect(viewer.app.captureCharFrame()).toContain("▶ new:1")
      viewer.app.mockInput.pressKey("\x1b[1;1:2B".repeat(20))
      await viewer.app.waitForFrame((frame) => frame.includes("▶ new:21") && frame.includes("row021"))
      viewer.app.mockInput.pressKey("\x1b[1;1:2B".repeat(10))
      await viewer.app.waitForFrame((frame) => frame.includes("▶ new:31") && frame.includes("row031"))
      const scroll = findScrollBox(viewer.app.renderer.root)!
      expect(scroll.scrollTop).toBeGreaterThan(0)
      expect(
        viewer.app
          .captureCharFrame()
          .split("\n")
          .find((line) => line.includes("row031")),
      ).toContain("▶")
      viewer.app.mockInput.pressKey("\x1b[1;1:3B")
      await viewer.app.renderOnce()
      expect(viewer.app.captureCharFrame()).toContain("▶ new:31")
      viewer.app.mockInput.pressKey("\x1b[6~")
      await viewer.app.waitForFrame((frame) => /▶ new:(3[2-9]|[4-9]\d)/.test(frame))
      viewer.app.mockInput.pressKey("\x1b[5~")
      await viewer.app.waitForFrame((frame) => frame.includes("▶ new:31") && frame.includes("row031"))
      viewer.app.mockInput.pressKey("\x1b[1;1:2B".repeat(120))
      await viewer.app.waitForFrame((frame) => frame.includes("▶ new:100") && frame.includes("row100"))
      expect(
        viewer.app
          .captureCharFrame()
          .split("\n")
          .find((line) => line.includes("row100")),
      ).toContain("▶")
      viewer.app.mockInput.pressKey("\x1b[1;1:2A".repeat(120))
      await viewer.app.waitForFrame(
        (frame) => frame.includes("▶ new:1") && frame.includes("row001") && scroll.scrollTop === 0,
      )
      const node = findDiff(viewer.app.renderer.root)!
      const panes = node.getChildren().filter((node) => node instanceof LineNumberRenderable)
      const pane = panes[width === 80 ? 0 : 1]
      const code = pane.getChildren().find((node) => node instanceof CodeRenderable) as CodeRenderable
      await viewer.app.mockMouse.click(code.x + 2, code.y + 1)
      await viewer.app.renderOnce()
      expect(viewer.app.captureCharFrame()).toContain("▶ new:2")
      viewer.app.mockInput.pressArrow("down")
      await viewer.app.renderOnce()
      expect(viewer.app.captureCharFrame()).toContain("▶ new:3")
      viewer.app.mockInput.typeText("a")
      await viewer.app.waitForFrame((frame) => frame.includes("scroll.txt:3 (new, working tree)"))
      const editor = viewer.app.renderer.currentFocusedEditor as TextareaRenderable
      editor.setText("Review the active row")
      viewer.app.mockInput.pressEnter()
      await viewer.app.waitForFrame((frame) => frame.includes("1 notes"))
      viewer.commands.get("diff.close")!.run?.({} as never)
      const route = viewer.current()
      const prompt = ("params" in route ? route.params?.prompt : undefined) as PromptInfo
      const part = prompt.parts[0]
      if (part.type !== "text") throw new Error("Expected annotation text")
      expect(part.text).toContain("scroll.txt:3 (new, working tree)")
      expect(part.text).toContain("    row003")
    } finally {
      await viewer.dispose()
    }
  })

  test(`selected ${width === 80 ? "unified" : "split"} code lines have a visible cursor and survive hunk collapse and style rebuilds`, async () => {
    const viewer = await renderDiffViewer([reviewPatch], 36, undefined, width)
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("old two"))
      const clickLine = async (line: number, shift = false) => {
        const node = findDiff(viewer.app.renderer.root)!
        const pane = node.getChildren().find((node) => node instanceof LineNumberRenderable)!
        const code = pane.getChildren().find((node) => node instanceof CodeRenderable) as CodeRenderable
        const row = code.lineInfo.lineSources.findIndex((row) => pane.getLineNumbers().get(row) === line)
        await viewer.app.mockMouse.click(code.x + 2, code.y + row, MouseButton.LEFT, { modifiers: { shift } })
        await viewer.app.renderOnce()
      }
      const codeRow = (text: string) =>
        viewer.app.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes(text)))!
      const codeBackground = (text: string) =>
        codeRow(text)
          .spans.find((span) => span.text.includes(text))!
          .bg.toInts()
      await clickLine(11)
      expect(
        codeRow("old one")
          .spans.map((span) => span.text)
          .join(""),
      ).toContain("▶")
      expect(codeBackground("old one")).not.toEqual(codeBackground("old two"))
      await clickLine(12, true)
      expect(
        codeRow("old one")
          .spans.map((span) => span.text)
          .join(""),
      ).toContain("▎")
      expect(
        codeRow("old two")
          .spans.map((span) => span.text)
          .join(""),
      ).toContain("▶")
      expect(codeBackground("old one")).not.toEqual(codeBackground("old two"))
      expect(viewer.app.captureCharFrame()).toContain("current 12")
      const color = codeBackground("old two")
      viewer.commands.get("diff.mark_reviewed")!.run?.({} as never)
      await viewer.app.renderOnce()
      await viewer.app.renderOnce()
      expect(codeBackground("old two")).toEqual(color)
      viewer.app.resize(width + 6, 36)
      await viewer.app.renderOnce()
      await viewer.app.renderOnce()
      expect(codeBackground("old two")).toEqual(color)
      const clickFold = async (label: string) => {
        const lines = viewer.app.captureCharFrame().split("\n")
        const row = lines.findIndex((line) => line.includes("@@ -10"))
        await viewer.app.mockMouse.click(lines[row].indexOf(label), row)
        await viewer.app.renderOnce()
      }
      await clickFold("collapse")
      expect(viewer.app.captureCharFrame()).not.toContain("old two")
      expect(viewer.app.captureCharFrame()).toContain("expand")
      await clickFold("expand")
      await viewer.app.renderOnce()
      expect(
        codeRow("old two")
          .spans.map((span) => span.text)
          .join(""),
      ).toContain("▶")
      expect(codeBackground("old two")).toEqual(color)
      viewer.commands.get("diff.toggle_view")!.run?.({} as never)
      await viewer.app.renderOnce()
      await viewer.app.renderOnce()
      expect(
        codeRow("old two")
          .spans.map((span) => span.text)
          .join(""),
      ).toContain("▶")
      const lines = viewer.app.captureCharFrame().split("\n")
      const row = lines.findIndex((line) => line.includes("@@ -10"))
      await viewer.app.mockMouse.click(lines[row].indexOf("annotate lines"), row)
      await viewer.app.waitForFrame((frame) => frame.includes("src/review.txt:11-12 (old, working tree)"))
      expect(viewer.app.captureCharFrame()).toContain("old one")
    } finally {
      await viewer.dispose()
    }
  })

  test(`reverse ${width === 80 ? "unified" : "split"} added-line selection keeps new-side line numbers`, async () => {
    const viewer = await renderDiffViewer([reviewPatch], 30, undefined, width)
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("new two"))
      const node = findDiff(viewer.app.renderer.root)!
      const panes = node.getChildren().filter((node) => node instanceof LineNumberRenderable)
      const pane = panes[width === 80 ? 0 : 1]
      const code = pane.getChildren().find((node) => node instanceof CodeRenderable) as CodeRenderable
      const first = code.y + (width === 80 ? 3 : 1)
      expect(diffLineAt(node, pane.x + 1, first)).toEqual({ side: "new", line: 21 })
      await viewer.app.mockMouse.click(pane.x + 1, first + 1)
      await viewer.app.mockMouse.click(pane.x + 1, first, MouseButton.LEFT, { modifiers: { shift: true } })
      await viewer.app.renderOnce()
      expect(viewer.app.captureCharFrame()).toContain("new lines 21–22")
      viewer.commands.get("diff.annotate")!.run?.({} as never)
      await viewer.app.waitFor(() => viewer.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
      const editor = viewer.app.renderer.currentFocusedEditor as TextareaRenderable
      expect(viewer.app.captureCharFrame()).toContain("▶ new:21")
      editor.setText("Check both additions")
      viewer.commands.get("dialog.prompt.submit")!.run?.({} as never)
      viewer.commands.get("diff.close")!.run?.({} as never)
      const route = viewer.current()
      const prompt = ("params" in route ? route.params?.prompt : undefined) as PromptInfo
      const part = prompt.parts[0]
      if (part.type !== "text") throw new Error("Expected annotation text")
      expect(part.text).toContain("src/review.txt:21-22 (new, working tree)")
      expect(part.text).toContain("    new one\n    new two")
    } finally {
      await viewer.dispose()
    }
  })

  test(`${width === 80 ? "unified" : "split"} navigation follows wrapped source rows after resize and skips context-only hunks`, async () => {
    const viewer = await renderDiffViewer(
      [
        {
          ...reviewPatch,
          patch:
            "--- a/src/review.txt\n+++ b/src/review.txt\n@@ -1,4 +1,4 @@\n context\n-" +
            "long old ".repeat(30) +
            "\n-old two\n+new one\n+new two\n tail\n@@ -20 +20 @@\n only context\n@@ -40,0 +40,2 @@\n+last one\n+last two",
        },
      ],
      45,
      undefined,
      width,
    )
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("old two"))
      const pane = findDiff(viewer.app.renderer.root)!.getChildren()[0] as LineNumberRenderable
      const code = pane.getChildren().find((node) => node instanceof CodeRenderable) as CodeRenderable
      const row = code.lineInfo.lineSources.findIndex((row) => pane.getLineNumbers().get(row) === 2)
      await viewer.app.mockMouse.click(code.x + 1, code.y + row)
      viewer.app.mockInput.pressArrow("down")
      await viewer.app.waitForFrame((frame) => frame.includes("▶ old:3"))
      const height = findDiff(viewer.app.renderer.root)!.height
      viewer.app.resize(width + 30, 45)
      await viewer.app.flush()
      expect(findDiff(viewer.app.renderer.root)!.height).toBeLessThan(height)
      viewer.app.mockInput.pressArrow("up")
      await viewer.app.waitForFrame((frame) => frame.includes("▶ old:2"))
      viewer.app.mockInput.pressKey("\x1b[1;1:2B".repeat(width === 80 ? 4 : 2))
      await viewer.app.waitForFrame((frame) => frame.includes("▶ new:40"))
      viewer.app.mockInput.typeText("t")
      viewer.app.mockInput.pressArrow("up")
      await viewer.app.waitForFrame((frame) => frame.includes("▶ new:20"))
      viewer.app.mockInput.typeText("t")
      viewer.app.mockInput.pressArrow("up")
      await viewer.app.waitForFrame((frame) => frame.includes("▶ new:3"))
      viewer.commands.get("diff.toggle_view")!.run?.({} as never)
      await viewer.app.flush()
      viewer.app.mockInput.pressArrow("down")
      await viewer.app.waitForFrame((frame) => frame.includes("▶ new:40"))
    } finally {
      await viewer.dispose()
    }
  })

  test(`mouse ${width === 80 ? "unified" : "split"} deleted-line range creates a compact draft preserving existing input`, async () => {
    const viewer = await renderDiffViewer(
      [reviewPatch],
      30,
      {
        name: "diff",
        params: { mode: "git", returnRoute: startRoute, draft: { input: "Existing draft", parts: [] } },
      },
      width,
    )
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("old one"))
      const node = findDiff(viewer.app.renderer.root)!
      const pane = node.getChildren().find((node) => node instanceof LineNumberRenderable)!
      const code = pane.getChildren().find((node) => node instanceof CodeRenderable) as CodeRenderable
      const first = code.y + 1
      expect(diffLineAt(node, pane.x + 1, first)).toEqual({ side: "old", line: 11 })
      await viewer.app.mockMouse.click(pane.x + 1, first)
      await viewer.app.mockMouse.click(pane.x + 1, first + 1, MouseButton.LEFT, { modifiers: { shift: true } })
      await viewer.app.renderOnce()
      expect(viewer.app.captureCharFrame()).toContain("old lines 11–12")
      viewer.commands.get("diff.annotate")!.run?.({} as never)
      await viewer.app.waitFor(() => viewer.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
      const textarea = viewer.app.renderer.currentFocusedEditor as TextareaRenderable
      viewer.app.mockInput.typeText("a question")
      expect(textarea.plainText).toBe("a question")
      textarea.setText("Keep the old behavior")
      viewer.commands.get("dialog.prompt.submit")!.run?.({} as never)
      await viewer.app.renderOnce()
      expect(viewer.app.captureCharFrame()).toContain("Keep the old behavior")
      viewer.commands.get("diff.close")!.run?.({} as never)
      const route = viewer.current()
      const prompt = ("params" in route ? route.params?.prompt : undefined) as PromptInfo
      expect(prompt.input).toBe("Existing draft\n\n[Diff annotations: 1 comment · 1 file]")
      expect(prompt.parts).toHaveLength(1)
      const part = prompt.parts[0]
      expect(part.type).toBe("text")
      if (part.type !== "text") throw new Error("Expected annotation text")
      expect(part.text).toContain("src/review.txt:11-12 (old, working tree)")
      expect(part.text).toContain("    old one\n    old two")
      expect(part.text).not.toContain("new one")
    } finally {
      await viewer.dispose()
    }
  })
}

test("code dragging remains available for copying rather than annotation selection", async () => {
  const viewer = await renderDiffViewer([reviewPatch], 28)
  try {
    await viewer.app.waitForFrame((frame) => frame.includes("old one"))
    const node = findDiff(viewer.app.renderer.root)!
    const pane = node.getChildren().find((node) => node instanceof LineNumberRenderable)!
    const code = pane.getChildren().find((node) => node instanceof CodeRenderable) as CodeRenderable
    await viewer.app.mockMouse.drag(code.x, code.y + 1, code.x + 7, code.y + 1)
    await viewer.app.renderOnce()
    expect(viewer.app.renderer.getSelection()?.getSelectedText()).toContain("old one")
    expect(viewer.app.captureCharFrame()).not.toContain("lines 11–11")
  } finally {
    await viewer.dispose()
  }
})

test("active-line navigation skips folded hunks and continues across files", async () => {
  const viewer = await renderDiffViewer(
    [
      {
        file: "a/review.txt",
        additions: 3,
        deletions: 3,
        status: "modified",
        patch:
          "--- a/a/review.txt\n+++ b/a/review.txt\n@@ -1 +1 @@\n-first old\n+first new\n@@ -20 +20 @@\n-second old\n+second new\n@@ -40 +40 @@\n-third old\n+third new",
      },
      {
        file: "z/next.txt",
        additions: 1,
        deletions: 0,
        status: "added",
        patch: "--- /dev/null\n+++ b/z/next.txt\n@@ -0,0 +1 @@\n+next file",
      },
    ],
    30,
  )
  try {
    await viewer.app.waitForFrame((frame) => frame.includes("first new"))
    const lines = viewer.app.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes("first new"))
    await viewer.app.mockMouse.click(lines[row].indexOf("first new"), row)
    viewer.app.mockInput.pressArrow("down")
    await viewer.app.waitForFrame((frame) => frame.includes("▶ old:20"))
    viewer.commands.get("diff.collapse")!.run?.({} as never)
    await viewer.app.renderOnce()
    expect(viewer.app.captureCharFrame()).not.toContain("second old")
    viewer.app.mockInput.pressArrow("down")
    await viewer.app.waitForFrame((frame) => frame.includes("▶ old:40"))
    viewer.app.mockInput.pressKey("\x1b[1;1:2B".repeat(2))
    await viewer.app.waitForFrame(
      (frame) =>
        frame.includes("▶ new:1") &&
        frame.split("\n").some((line) => line.includes("next file") && line.includes("▶")),
    )
    viewer.app.mockInput.pressArrow("up")
    await viewer.app.waitForFrame((frame) => frame.includes("▶ new:40"))
  } finally {
    await viewer.dispose()
  }
})

test.each([80, 160])(
  "large diff arrow bursts cross hunk and file boundaries in both directions (%i columns)",
  async (width) => {
    const viewer = await renderDiffViewer(
      Array.from({ length: 20 }, (_, file) => ({
        file: `file-${String(file).padStart(2, "0")}.txt`,
        additions: 200,
        deletions: 0,
        status: "modified",
        patch:
          `--- a/file-${file}.txt\n+++ b/file-${file}.txt\n` +
          Array.from(
            { length: 10 },
            (_, hunk) =>
              `@@ -${hunk * 100 + 1},0 +${hunk * 100 + 1},20 @@\n` +
              Array.from({ length: 20 }, (_, line) => `+file${file} hunk${hunk} row${line + 1}`).join("\n"),
          ).join("\n"),
      })),
      28,
      undefined,
      width,
    )
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("file0 hunk0 row1"))
      viewer.app.mockInput.pressArrow("down")
      // Deliver the burst after the first reveal's layout, while its second RAF
      // is still pending. New input must receive its own post-layout correction.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => viewer.app.renderer.once("frame", () => resolve())),
      )
      const expectVisible = (text: string) => {
        const viewport = findScrollBox(viewer.app.renderer.root)!.viewport
        const row = viewer.app
          .captureCharFrame()
          .split("\n")
          .findIndex((line) => line.includes(text) && line.includes("▶"))
        expect(row).toBeGreaterThanOrEqual(viewport.y)
        expect(row).toBeLessThan(viewport.y + viewport.height)
      }
      const samples = []
      for (let trial = 0; trial < 3; trial++) {
        const start = performance.now()
        viewer.app.mockInput.pressKey("\x1b[1;1:2B".repeat(205))
        samples.push(performance.now() - start)
        await viewer.app.waitForFrame((frame) => frame.includes("▶ new:6"))
        await viewer.app.flush()
        expectVisible("file1 hunk0 row6")
        const scrollTop = findScrollBox(viewer.app.renderer.root)!.scrollTop
        for (let frame = 0; frame < 3; frame++) {
          await viewer.app.renderOnce()
          expectVisible("file1 hunk0 row6")
          expect(findScrollBox(viewer.app.renderer.root)!.scrollTop).toBe(scrollTop)
        }
        expect(viewer.app.captureCharFrame()).toContain("▶ new:6")
        viewer.commands.get("diff.annotate")!.run?.({} as never)
        await viewer.app.waitForFrame((frame) => frame.includes("file-01.txt:6 (new, working tree)"))
        viewer.commands.get("dialog.prompt.submit")!.run?.({} as never)
        await viewer.app.flush()
        viewer.app.mockInput.pressKey("\x1b[1;1:2A".repeat(205))
        await viewer.app.waitForFrame((frame) => frame.includes("file0 hunk0 row1") && frame.includes("▶ new:1"))
        await viewer.app.flush()
        expectVisible("file0 hunk0 row1")
        expect(viewer.app.captureCharFrame()).toContain("▶ new:1")
        expect(viewer.app.captureCharFrame()).toContain("file0 hunk0 row1")
      }
      if (process.env.DIFF_NAV_BENCH) console.log(JSON.stringify({ width, arrowBurst205Milliseconds: samples }))
      viewer.app.mockInput.pressKey("\x1b[6~")
      await viewer.app.waitForFrame((frame) => /▶ new:10\d/.test(frame))
      viewer.app.mockInput.pressKey("\x1b[5~")
      await viewer.app.waitForFrame((frame) => frame.includes("▶ new:1"))
      viewer.app.mockInput.pressKey("\x1b[6~".repeat(200))
      await viewer.app.waitForFrame((frame) => frame.includes("▶ new:920"))
      await viewer.app.flush()
      expectVisible("file19 hunk9 row20")
      viewer.commands.get("diff.annotate")!.run?.({} as never)
      await viewer.app.waitForFrame((frame) => frame.includes("file-19.txt:920 (new, working tree)"))
      viewer.commands.get("dialog.prompt.submit")!.run?.({} as never)
      await viewer.app.flush()
      viewer.app.mockInput.pressKey("\x1b[5~".repeat(200))
      await viewer.app.waitForFrame((frame) => frame.includes("▶ new:1") && frame.includes("file0 hunk0 row1"))
      await viewer.app.flush()
      expectVisible("file0 hunk0 row1")
    } finally {
      await viewer.dispose()
    }
  },
  30000,
)

test("source switching carries annotations and the original prompt draft", async () => {
  const note = {
    id: "review-1",
    file: reviewPatch.file,
    source: "working tree",
    hunk: "@@ -10,3 +20,3 @@",
    side: "new",
    start: 21,
    end: 21,
    preview: "new one",
    comment: "Check this",
  }
  const viewer = await renderDiffViewer([reviewPatch], 32, {
    name: "diff",
    params: {
      mode: "git",
      sessionID: "session-1",
      returnRoute: startRoute,
      annotations: [note],
      draft: { input: "My draft", parts: [] },
    },
  })
  try {
    await viewer.app.waitForFrame((frame) => frame.includes("Check this"))
    viewer.commands.get("diff.switch_source")!.run?.({} as never)
    await viewer.app.waitForFrame((frame) => frame.includes("Last turn"))
    const lines = viewer.app.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes("Last turn"))
    await viewer.app.mockMouse.click(lines[row].indexOf("Last turn"), row)
    const route = viewer.current()
    const params = ("params" in route ? route.params : undefined) as Record<string, unknown> | undefined
    expect(route.name).toBe("diff")
    expect(params?.mode).toBe("last-turn")
    expect(params?.annotations).toEqual([note])
    expect(params?.draft).toEqual({ input: "My draft", parts: [] })
  } finally {
    await viewer.dispose()
  }
})

test("existing annotation can be edited and deleted by saving an empty comment", async () => {
  const viewer = await renderDiffViewer([reviewPatch], 32, {
    name: "diff",
    params: {
      mode: "git",
      returnRoute: startRoute,
      annotations: [
        {
          id: "review-1",
          file: reviewPatch.file,
          source: "working tree",
          hunk: "@@ -10,3 +20,3 @@",
          side: "new",
          start: 21,
          end: 21,
          preview: "new one",
          comment: "Check this",
        },
      ],
    },
  })
  try {
    await viewer.app.waitForFrame((frame) => frame.includes("Check this"))
    const lines = viewer.app.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes("Check this"))
    await viewer.app.mockMouse.click(lines[row].indexOf("Check this"), row)
    await viewer.app.waitFor(() => viewer.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = viewer.app.renderer.currentFocusedEditor as TextareaRenderable
    expect(textarea.plainText).toBe("Check this")
    textarea.setText("")
    viewer.commands.get("dialog.prompt.submit")!.run?.({} as never)
    await viewer.app.renderOnce()
    expect(viewer.app.captureCharFrame()).not.toContain("Check this")
    viewer.commands.get("diff.close")!.run?.({} as never)
    expect(viewer.current()).toEqual(startRoute)
  } finally {
    await viewer.dispose()
  }
})

function findDiff(root: Renderable): DiffRenderable | undefined {
  return findDiffs(root)[0]
}

function findDiffs(root: Renderable): DiffRenderable[] {
  if (root instanceof DiffRenderable) return [root]
  return root.getChildren().flatMap(findDiffs)
}

for (const width of [80, 160]) {
  test(`wrapped ${width === 80 ? "unified" : "split"} gutters keep source line identity while dragging`, async () => {
    const viewer = await renderDiffViewer(
      [{ ...reviewPatch, patch: reviewPatch.patch.replace("-old one", "-" + "old one ".repeat(24)) }],
      45,
      undefined,
      width,
    )
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("old two"))
      const node = findDiff(viewer.app.renderer.root)!
      const pane = node.getChildren().find((node) => node instanceof LineNumberRenderable) as LineNumberRenderable
      const code = pane.getChildren().find((node) => node instanceof CodeRenderable) as CodeRenderable
      const rows = code.lineInfo.lineSources
      const first = rows.findIndex((row) => pane.getLineNumbers().get(row) === 11)
      const last = rows.findIndex((row) => pane.getLineNumbers().get(row) === 12)
      expect(last - first).toBeGreaterThan(1)
      expect(diffLineAt(node, pane.x + 1, code.y + first + 1)).toEqual({ side: "old", line: 11 })
      await viewer.app.mockMouse.drag(pane.x + 1, code.y + first, pane.x + 1, code.y + last)
      await viewer.app.renderOnce()
      expect(viewer.app.captureCharFrame()).toContain("old lines 11–12")
      expect(viewer.app.renderer.getSelection()?.getSelectedText() ?? "").toBe("")
    } finally {
      await viewer.dispose()
    }
  })
}

async function renderDiffViewer(
  vcsDiff: unknown[],
  height = 20,
  initialRoute?: TuiRouteCurrent,
  width = 80,
  kittyKeyboard = false,
) {
  const tmp = await tmpdir()
  const cleanup: Promise<void>[] = []
  const commands = new Map<
    string,
    NonNullable<Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]["commands"]>[number]
  >()
  let current = initialRoute ?? startRoute
  let renderDiff: TuiRouteDefinition["render"] | undefined
  let vcsDiffInput: unknown
  let sessionDiffInput: unknown
  const config = createTuiResolvedConfig()
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    const registerLayer = keymap.registerLayer.bind(keymap)
    keymap.registerLayer = (layer) => {
      layer.commands?.forEach((command) => commands.set(command.name, command))
      return registerLayer(layer)
    }
    const base = createTuiPluginApi({
      keymap,
      client: {
        vcs: {
          diff: async (input: unknown) => {
            vcsDiffInput = input
            return { data: vcsDiff }
          },
        },
        session: {
          diff: async (input: unknown) => {
            sessionDiffInput = input
            return { data: [] }
          },
        },
      } as unknown as TuiPluginApi["client"],
      state: {
        session: {
          get: () => session,
        },
      },
    })
    const api = {
      ...base,
      route: {
        register(routes) {
          renderDiff = routes.find((route) => route.name === "diff")?.render
          return () => {}
        },
        navigate(name, params) {
          current = params ? { name, params } : { name }
        },
        get current() {
          return current
        },
      },
    } satisfies TuiPluginApi

    function Viewer() {
      const dialog = useDialog()
      api.ui.dialog = {
        ...dialog,
        get depth() {
          return dialog.stack.length
        },
        get open() {
          return dialog.stack.length > 0
        },
      }
      return renderDiff?.({ params: "params" in current ? current.params : undefined })
    }

    void diffViewerPlugin.tui(api, undefined, pluginMeta)
    if (!initialRoute) commands.get("diff.open")?.run?.({} as never)

    return (
      <TestTuiContexts paths={{ state: tmp.path, home: tmp.path }} onDispose={(done) => cleanup.push(done)}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <Viewer />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width, height, kittyKeyboard })
  await waitForCommand(app, commands, "diff.close")
  return {
    app,
    async dispose() {
      app.renderer.destroy()
      await Promise.all(cleanup)
      await tmp[Symbol.asyncDispose]()
    },
    commands,
    current: () => current,
    vcsDiffInput: () => vcsDiffInput,
    sessionDiffInput: () => sessionDiffInput,
  }
}

const startRoute: TuiRouteCurrent = { name: "session", params: { sessionID: "session-1" } }

function findScrollBox(root: Renderable): ScrollBoxRenderable | undefined {
  if (root instanceof ScrollBoxRenderable && containsDiff(root)) return root
  return root.getChildren().map(findScrollBox).find(Boolean)
}

function containsDiff(root: Renderable): boolean {
  if (root instanceof DiffRenderable) return true
  return root.getChildren().some(containsDiff)
}

const session = {
  id: "session-1",
  slug: "session-1",
  projectID: "project-1",
  directory: "/repo/session",
  title: "Session",
  version: "1",
  time: {
    created: 0,
    updated: 0,
  },
} satisfies Session

test("branch diff source requests branch VCS diff", async () => {
  const viewer = await renderDiffViewer([], 20, {
    name: "diff",
    params: { mode: "branch", sessionID: "session-1", returnRoute: startRoute },
  })
  try {
    expect(viewer.current()).toEqual({
      name: "diff",
      params: { mode: "branch", sessionID: "session-1", returnRoute: startRoute },
    })
    expect(viewer.vcsDiffInput()).toEqual({ directory: "/repo/session", mode: "branch", context: 12 })
    expect(viewer.sessionDiffInput()).toBeUndefined()
  } finally {
    await viewer.dispose()
  }
})

test("last-turn diff source requests session diff", async () => {
  const viewer = await renderDiffViewer([], 20, {
    name: "diff",
    params: { mode: "last-turn", sessionID: "session-1", messageID: "message-1", returnRoute: startRoute },
  })
  try {
    expect(viewer.current()).toEqual({
      name: "diff",
      params: { mode: "last-turn", sessionID: "session-1", messageID: "message-1", returnRoute: startRoute },
    })
    expect(viewer.sessionDiffInput()).toEqual({ sessionID: "session-1", messageID: "message-1" })
    expect(viewer.vcsDiffInput()).toBeUndefined()
  } finally {
    await viewer.dispose()
  }
})

async function waitForCommand(
  app: Awaited<ReturnType<typeof testRender>>,
  commands: Map<string, unknown>,
  command: string,
) {
  for (let attempt = 0; attempt < 10; attempt++) {
    await app.renderOnce()
    if (commands.has(command)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const pluginMeta = {
  id: "diff-viewer",
  source: "internal",
  spec: "diff-viewer",
  target: "diff-viewer",
  first_time: 0,
  last_time: 0,
  time_changed: 0,
  load_count: 1,
  fingerprint: "test",
  state: "same",
} satisfies TuiPluginMeta

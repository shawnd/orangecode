/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { InputRenderable, TextareaRenderable, TextAttributes } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import { NativeReminders } from "@opencode-ai/core/native/reminders"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { tmpdir } from "../../fixture/fixture"
import { RemindersProvider, useReminders } from "../../../src/context/reminders"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider, useTheme } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { ToastProvider } from "../../../src/ui/toast"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { DialogReminderCreate } from "../../../src/component/dialog-reminders"
import { ReminderIndicator } from "../../../src/component/reminder-indicator"

async function wait(fn: () => boolean, timeout = 4000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for reminder UI")
    await Bun.sleep(10)
  }
}

test("native shared notifications stay visible until addressed through the palette", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let reminders!: ReturnType<typeof useReminders>
  let dialog!: ReturnType<typeof useDialog>
  let theme!: ReturnType<typeof useTheme>["theme"]

  function Probe() {
    reminders = useReminders()
    dialog = useDialog()
    theme = useTheme().theme
    return <ReminderIndicator />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <RemindersProvider>
                    <DialogProvider>
                      <Probe />
                    </DialogProvider>
                  </RemindersProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 32 })
  const click = async (label: string) => {
    await app.renderOnce()
    const lines = app.captureCharFrame().split("\n")
    const y = lines.findLastIndex((line) => line.includes(label))
    if (y < 0) throw new Error(`Missing ${label}: ${app.captureCharFrame()}`)
    await app.mockMouse.click(lines[y].indexOf(label) + 1, y)
  }
  try {
    await wait(() => reminders !== undefined)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("◷ (0)")
    expect(
      app
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text.includes("◷"))
        ?.fg.toInts(),
    ).toEqual(theme.textMuted.toInts())
    await reminders.create({ title: "upcoming CI", due: Date.now() + 3600000 })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("◷ (1)")

    const other = NativeReminders.open(`${tmp.path}/reminders.sqlite3`)
    try {
      other.create({ title: "check build now", due: Date.now() - 1000 }, Date.now() - 2000)
      await wait(() => reminders.snapshot().reminders.length === 2)
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("◷ 1 (2)")
      const spans = app.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes("◷")))?.spans
      const alarm = spans?.find((span) => span.text.trim() === "1")
      expect(spans?.find((span) => span.text.includes("◷"))?.fg.toInts()).toEqual(theme.warning.toInts())
      expect(alarm?.fg.toInts()).toEqual(theme.warning.toInts())
      expect((alarm?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
      expect(spans?.find((span) => span.text.includes("(2)"))?.fg.toInts()).toEqual(theme.textMuted.toInts())
      await click("1 (2)")
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("Reminders · all terminals")
      expect(app.captureCharFrame()).toContain("Due now")
      expect(app.captureCharFrame()).toContain("Upcoming")
      await click("check build now")
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("Mark addressed")
      await click("Mark addressed")
      await wait(() => reminders.snapshot().reminders.some((item) => item.completed !== null))
      expect(other.poll()?.reminders.find((item) => item.title === "check build now")?.completed).not.toBeNull()
      dialog.clear()
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("◷ (1)")
      expect(
        app
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .find((span) => span.text.includes("◷"))
          ?.fg.toInts(),
      ).toEqual(theme.textMuted.toInts())

      dialog.replace(() => <DialogReminderCreate value="in twenty minutes review CI" />)
      await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
      app.mockInput.pressEnter()
      await wait(() => dialog.stack.length > 0 && app.renderer.currentFocusedEditor instanceof InputRenderable)
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("Confirm reminder")
      expect(app.captureCharFrame()).toContain("review CI")
      expect(reminders.snapshot().reminders).toHaveLength(2)
      await click("Schedule reminder")
      await wait(() => reminders.snapshot().reminders.length === 3)
      expect(other.poll()?.reminders.some((item) => item.title === "review CI")).toBe(true)
    } finally {
      other.close()
    }
  } finally {
    app.renderer.destroy()
  }
})

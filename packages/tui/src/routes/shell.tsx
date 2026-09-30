import type { ScrollBoxRenderable } from "@opentui/core"
import { createMemo, Show } from "solid-js"
import { useRoute, useRouteData } from "../context/route"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { useDialog } from "../ui/dialog"

export function Shell() {
  let scroll: ScrollBoxRenderable | undefined
  const route = useRoute()
  const data = useRouteData("session")
  const sync = useSync()
  const dialog = useDialog()
  const { theme } = useTheme()
  const part = createMemo(() =>
    sync.data.part[data.shell?.messageID ?? ""]?.find((part) => part.id === data.shell?.partID),
  )
  const state = createMemo(() => {
    const value = part()
    return value?.type === "tool" ? value.state : undefined
  })
  const metadata = createMemo(() => {
    const value = state()
    return value && "metadata" in value ? value.metadata : undefined
  })
  const output = createMemo(() => {
    const value = state()
    const info = metadata()
    if (!value) return "Shell output is no longer available."
    if (info?.background === true && typeof info.output === "string") {
      return (
        info.output || (info.shellStatus === "running" ? "Waiting for output…" : String(info.error ?? "(no output)"))
      )
    }
    if (value.status === "completed") return value.output
    if (value.status === "error") return value.error
    return typeof info?.output === "string" && info.output ? info.output : "Waiting for output…"
  })
  const back = () => route.navigate({ type: "session", sessionID: data.shell?.returnSessionID ?? data.sessionID })
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      { key: "up", desc: "Scroll shell output up", group: "Shell", cmd: () => scroll?.scrollBy(-1) },
      { key: "down", desc: "Scroll shell output down", group: "Shell", cmd: () => scroll?.scrollBy(1) },
      {
        key: "pageup",
        desc: "Page shell output up",
        group: "Shell",
        cmd: () => scroll?.scrollBy(-(scroll.height / 2)),
      },
      {
        key: "pagedown",
        desc: "Page shell output down",
        group: "Shell",
        cmd: () => scroll?.scrollBy(scroll.height / 2),
      },
      { key: "home", desc: "First shell output", group: "Shell", cmd: () => scroll?.scrollTo(0) },
      { key: "end", desc: "Follow shell output", group: "Shell", cmd: () => scroll?.scrollTo(scroll.scrollHeight) },
      { key: "ctrl+up", desc: "Return to session", group: "Shell", cmd: back },
      { key: "escape", desc: "Return to session", group: "Shell", cmd: back },
      {
        key: "return",
        desc: "Open shell's session",
        group: "Shell",
        cmd: () => route.navigate({ type: "session", sessionID: data.sessionID }),
      },
    ],
  }))
  return (
    <box flexGrow={1} minHeight={0} paddingX={2} paddingTop={1} gap={1}>
      <box flexShrink={0} gap={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text}>
            <b>Shell</b> · {String(metadata()?.shellStatus ?? state()?.status ?? "finished")}
          </text>
          <text fg={theme.textMuted} onMouseUp={back}>
            ctrl+↑ / esc return
          </text>
        </box>
        <text fg={theme.accent}>{String(state()?.input.command ?? "Shell command")}</text>
        <Show when={metadata()?.background === true}>
          <text fg={theme.textMuted}>
            {String(metadata()?.jobId)} · stdin {metadata()?.stdinOpen ? "open" : "closed"}
            {"\n"}
            Log: {String(metadata()?.outputPath)}
          </text>
        </Show>
      </box>
      <scrollbox ref={(value) => (scroll = value)} flexGrow={1} minHeight={0} stickyScroll stickyStart="bottom">
        <text fg={theme.text}>{output()}</text>
      </scrollbox>
      <box flexShrink={0} paddingY={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.textMuted}>↑/↓ scroll · pgup/pgdn page · home/end first/follow</text>
        <text fg={theme.textMuted} onMouseUp={() => route.navigate({ type: "session", sessionID: data.sessionID })}>
          enter open session
        </text>
      </box>
    </box>
  )
}

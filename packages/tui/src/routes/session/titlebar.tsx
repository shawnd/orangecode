import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { InputRenderable, MouseButton, type MouseEvent } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { useSync } from "../../context/sync"
import { useTheme, type Theme } from "../../context/theme"
import { useClipboard } from "../../context/clipboard"
import { useToast } from "../../ui/toast"
import { useSDK } from "../../context/sdk"
import { useBindings, useOpencodeModeStack } from "../../keymap"

export function Titlebar(props: { sessionID: string; width: number }) {
  const sync = useSync()
  const { theme } = useTheme()
  const clipboard = useClipboard()
  const toast = useToast()
  const sdk = useSDK()
  const session = createMemo(() => sync.session.get(props.sessionID))
  return (
    <TitlebarContent
      sessionID={props.sessionID}
      title={session()?.title ?? ""}
      width={props.width}
      theme={theme}
      onRename={(title) =>
        void sdk.client.session.update({ sessionID: props.sessionID, title }, { throwOnError: true }).catch(toast.error)
      }
      onCopy={() =>
        void clipboard
          .write?.(props.sessionID)
          .then(() => toast.show({ message: "Session ID copied to clipboard", variant: "info" }))
          .catch(toast.error)
      }
    />
  )
}

export function TitlebarContent(props: {
  sessionID: string
  title: string
  width: number
  theme: Pick<Theme, "text" | "textMuted" | "backgroundPanel">
  onCopy: () => void
  onRename: (title: string) => void
}) {
  const [expanded, setExpanded] = createSignal(false)
  const [editing, setEditing] = createSignal(false)
  let lastClick = 0
  let timeout: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timeout))
  createEffect(
    on(
      () => props.sessionID,
      () => {
        clearTimeout(timeout)
        setExpanded(false)
        setEditing(false)
        lastClick = 0
      },
    ),
  )
  const fullTitle = createMemo(() => props.title.replace(/\s+/g, " "))
  const id = createMemo(() => {
    if (Bun.stringWidth(fullTitle()) + Bun.stringWidth(props.sessionID) + 1 <= props.width) return props.sessionID
    return truncateTitle(
      props.sessionID.length > 9 ? `${props.sessionID.slice(0, 9)}…` : props.sessionID,
      Math.max(1, props.width - 2),
    )
  })
  const titleWidth = createMemo(() => Math.max(0, props.width - Bun.stringWidth(id()) - 1))
  const title = createMemo(() => truncateTitle(fullTitle(), titleWidth()))
  const reveal = (event: MouseEvent) => {
    if (event.button !== MouseButton.LEFT) return
    event.stopPropagation()
    clearTimeout(timeout)
    const now = Date.now()
    if (lastClick && now - lastClick <= 350) {
      lastClick = 0
      setExpanded(false)
      setEditing(true)
      return
    }
    lastClick = now
    setExpanded(true)
    timeout = setTimeout(() => setExpanded(false), 1000)
  }

  return (
    <box height={1} flexShrink={0}>
      <box height={1} flexDirection="row" gap={1} overflow="hidden">
        <box flexGrow={1} flexShrink={1} minWidth={0}>
          <text fg={props.theme.text} height={1} flexShrink={0} wrapMode="none" onMouseUp={reveal}>
            <b>{title()}</b>
          </text>
        </box>
        <text fg={props.theme.textMuted} height={1} flexShrink={0} wrapMode="none" onMouseUp={props.onCopy}>
          {id()}
        </text>
      </box>
      <Show when={expanded()}>
        <box
          position="absolute"
          top={0}
          left={0}
          width={props.width}
          zIndex={100}
          backgroundColor={props.theme.backgroundPanel}
          onMouseUp={reveal}
        >
          <text fg={props.theme.text} width="100%" wrapMode="word">
            <b>{props.title}</b>
          </text>
        </box>
      </Show>
      <Show when={editing()}>
        <TitlebarRename
          title={props.title}
          width={props.width}
          theme={props.theme}
          onCancel={() => setEditing(false)}
          onConfirm={(value) => {
            props.onRename(value)
            setEditing(false)
          }}
        />
      </Show>
    </box>
  )
}

function TitlebarRename(props: {
  title: string
  width: number
  theme: Pick<Theme, "text" | "backgroundPanel">
  onCancel: () => void
  onConfirm: (title: string) => void
}) {
  const renderer = useRenderer()
  const previous = renderer.currentFocusedRenderable
  const modeStack = useOpencodeModeStack()
  const [input, setInput] = createSignal<InputRenderable>()
  onCleanup(modeStack.push("modal"))
  onMount(() => {
    input()?.focus()
    input()?.gotoBufferEnd()
  })
  onCleanup(() => {
    if (renderer.currentFocusedRenderable !== input()) return
    if (previous && !previous.isDestroyed) previous.focus()
  })
  useBindings(() => ({
    target: input,
    enabled: input() !== undefined,
    priority: 1,
    bindings: [
      { key: "escape", desc: "Cancel rename", group: "Session", cmd: props.onCancel },
      { key: "return", desc: "Confirm rename", group: "Session", cmd: () => props.onConfirm(input()!.value) },
      { key: "up", desc: "Start of title", group: "Session", cmd: () => input()?.gotoBufferHome() },
      { key: "home", desc: "Start of title", group: "Session", cmd: () => input()?.gotoBufferHome() },
      { key: "down", desc: "End of title", group: "Session", cmd: () => input()?.gotoBufferEnd() },
      { key: "end", desc: "End of title", group: "Session", cmd: () => input()?.gotoBufferEnd() },
      { key: "left", desc: "Move cursor left", group: "Session", cmd: () => input()?.moveCursorLeft() },
      { key: "right", desc: "Move cursor right", group: "Session", cmd: () => input()?.moveCursorRight() },
    ],
  }))
  return (
    <box position="absolute" top={0} left={0} width={props.width} height={1} zIndex={100}>
      <input
        ref={setInput}
        value={props.title}
        width="100%"
        backgroundColor={props.theme.backgroundPanel}
        focusedBackgroundColor={props.theme.backgroundPanel}
        textColor={props.theme.text}
        focusedTextColor={props.theme.text}
        cursorColor={props.theme.text}
      />
    </box>
  )
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function truncateTitle(text: string, width: number) {
  if (width <= 0) return ""
  if (Bun.stringWidth(text) <= width) return text
  const parts: string[] = []
  let columns = 0
  for (const part of segmenter.segment(text)) {
    const size = Bun.stringWidth(part.segment)
    if (columns + size > width - 1) break
    parts.push(part.segment)
    columns += size
  }
  return parts.join("") + "…"
}

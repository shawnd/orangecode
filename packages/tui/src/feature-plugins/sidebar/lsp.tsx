import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal } from "solid-js"

const id = "internal:sidebar-lsp"

export function SidebarLspView(props: { api: TuiPluginApi }) {
  const [open, setOpen] = createSignal(true)
  const [updating, setUpdating] = createSignal(false)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.lsp())
  const off = createMemo(() => !props.api.state.config.lsp)
  const toggle = async () => {
    if (updating()) return
    setUpdating(true)
    const result = await props.api.client.config
      .update({ directory: props.api.state.path.directory, config: { lsp: off() } })
      .catch((error: unknown) => ({ error }))
    setUpdating(false)
    if (result.error)
      props.api.ui.toast({ title: "Could not update LSP setting", message: String(result.error), variant: "error" })
  }

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
        <Show when={list().length > 2}>
          <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
        </Show>
        <text fg={theme().text}>
          <b>LSP</b>
        </text>
      </box>
      <Show when={list().length <= 2 || open()}>
        <Show when={list().length === 0}>
          <text fg={theme().textMuted} onMouseUp={() => void toggle()}>
            {off() ? "LSPs are disabled (click to enable)" : "LSPs will activate as files are read (click to disable)"}
          </text>
        </Show>
        <For each={list()}>
          {(item) => (
            <box flexDirection="row" gap={1}>
              <text
                flexShrink={0}
                style={{
                  fg: item.status === "connected" ? theme().success : theme().error,
                }}
              >
                •
              </text>
              <text fg={theme().textMuted}>
                {item.id} {item.root}
              </text>
            </box>
          )}
        </For>
        <Show when={list().length > 0}>
          <text fg={theme().textMuted} onMouseUp={() => void toggle()}>
            Disable LSPs
          </text>
        </Show>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 300,
    slots: {
      sidebar_content() {
        return <SidebarLspView api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin

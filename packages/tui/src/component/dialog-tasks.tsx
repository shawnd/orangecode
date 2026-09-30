import { createMemo, onMount, Show } from "solid-js"
import { useSync } from "../context/sync"
import { useRoute } from "../context/route"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { sessionTasks } from "../util/session-background"

export function DialogTasks(props: { sessionID: string; kind: "agents" | "shells" }) {
  const sync = useSync()
  const route = useRoute()
  const dialog = useDialog()
  const tasks = createMemo(() => sessionTasks(props.sessionID, sync.data))
  return (
    <DialogSelect
      title={props.kind === "agents" ? "Background agents" : "Running shells"}
      preserveSelection
      options={
        props.kind === "agents"
          ? tasks().agents.map((agent) => ({
              title: sync.session.get(agent.id)?.title ?? agent.title,
              value: agent.id,
              description: sync.data.session_status[agent.id]?.type,
            }))
          : tasks().shells.map((part) => ({
              title: typeof part.state.input.command === "string" ? part.state.input.command : "Shell command",
              value: part.id,
              description: sync.session.get(part.sessionID)?.title,
            }))
      }
      onSelect={(option) => {
        if (props.kind === "shells") {
          const part = tasks().shells.find((part) => part.id === option.value)
          if (part)
            dialog.replace(() => <DialogShell messageID={part.messageID} partID={part.id} sessionID={part.sessionID} />)
          return
        }
        route.navigate({ type: "session", sessionID: option.value })
        dialog.clear()
      }}
    />
  )
}

function DialogShell(props: { messageID: string; partID: string; sessionID: string }) {
  const sync = useSync()
  const route = useRoute()
  const dialog = useDialog()
  const { theme } = useTheme()
  const part = createMemo(() => sync.data.part[props.messageID]?.find((part) => part.id === props.partID))
  const state = createMemo(() => {
    const value = part()
    return value?.type === "tool" ? value.state : undefined
  })
  const output = createMemo(() => {
    const value = state()
    if (
      value &&
      "metadata" in value &&
      value.metadata?.background === true &&
      typeof value.metadata.output === "string"
    ) {
      return (
        value.metadata.output ||
        (value.metadata.shellStatus === "running"
          ? "Waiting for output…"
          : String(value.metadata.error ?? "(no output)"))
      )
    }
    if (value?.status === "completed") return value.output
    if (value?.status === "error") return value.error
    return value?.status === "running" && typeof value.metadata?.output === "string"
      ? value.metadata.output
      : "Waiting for output…"
  })
  const metadata = createMemo(() => {
    const value = state()
    return value && "metadata" in value ? value.metadata : undefined
  })
  const open = () => {
    route.navigate({ type: "session", sessionID: props.sessionID })
    dialog.clear()
  }
  onMount(() => dialog.setSize("large"))
  useBindings(() => ({ bindings: [{ key: "return", desc: "Open shell session", group: "Dialog", cmd: open }] }))
  return (
    <box paddingX={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>Shell · {String(metadata()?.shellStatus ?? state()?.status ?? "finished")}</text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
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
      <scrollbox height={12} stickyScroll stickyStart="bottom">
        <text fg={theme.text}>{output()}</text>
      </scrollbox>
      <text fg={theme.textMuted} onMouseUp={open}>
        enter open session
      </text>
    </box>
  )
}

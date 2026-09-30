import { createMemo, type Accessor } from "solid-js"
import { useSync } from "../context/sync"
import { useRoute } from "../context/route"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { sessionTasks } from "../util/session-background"

export function useTaskNavigation(sessionID: Accessor<string | undefined>) {
  const sync = useSync()
  const route = useRoute()
  const dialog = useDialog()
  const tasks = createMemo(() => sessionTasks(sessionID(), sync.data))
  const select = (kind: "agents" | "shells", id: string) => {
    const parent = sessionID()
    if (!parent) return
    if (kind === "agents") {
      route.navigate({ type: "session", sessionID: id })
      dialog.clear()
      return
    }
    const part = tasks().shells.find((part) => part.id === id)
    if (!part) return
    route.navigate({
      type: "session",
      sessionID: part.sessionID,
      shell: { messageID: part.messageID, partID: part.id, returnSessionID: parent },
    })
    dialog.clear()
  }
  return {
    tasks,
    select,
    open(kind: "agents" | "shells") {
      const parent = sessionID()
      if (!parent) return
      const items = tasks()[kind]
      if (items.length === 0) return
      if (items.length === 1) {
        select(kind, items[0].id)
        return
      }
      dialog.replace(() => <DialogTasks sessionID={parent} kind={kind} />)
    },
  }
}

export function DialogTasks(props: { sessionID: string; kind: "agents" | "shells" }) {
  const sync = useSync()
  const navigation = useTaskNavigation(() => props.sessionID)
  return (
    <DialogSelect
      title={props.kind === "agents" ? "Background agents" : "Running shells"}
      preserveSelection
      options={
        props.kind === "agents"
          ? navigation.tasks().agents.map((agent) => ({
              title: sync.session.get(agent.id)?.title ?? agent.title,
              value: agent.id,
              description: sync.data.session_status[agent.id]?.type,
            }))
          : navigation.tasks().shells.map((part) => ({
              title: typeof part.state.input.command === "string" ? part.state.input.command : "Shell command",
              value: part.id,
              description: sync.session.get(part.sessionID)?.title,
            }))
      }
      onSelect={(option) => navigation.select(props.kind, option.value)}
    />
  )
}

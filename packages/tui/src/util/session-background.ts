import type { Part, Session, SessionStatus } from "@opencode-ai/sdk/v2"

export function sessionTasks(
  sessionID: string | undefined,
  data: {
    session: Pick<Session, "id" | "parentID">[]
    part: Record<string, Part[]>
    session_status: Record<string, SessionStatus>
  },
) {
  if (!sessionID) return { agents: [], shells: [] }
  const tools = Object.values(data.part)
    .flat()
    .filter((part) => part.type === "tool")
  const tasks = tools.filter((part) => part.tool === "task" && "metadata" in part.state)
  const descendants = new Set([sessionID])
  // Tool links also cover children outside the current session-list filter.
  const links = [
    ...data.session,
    ...tasks.flatMap((part) => {
      if (part.type !== "tool" || !("metadata" in part.state)) return []
      const id = part.state.metadata?.sessionId
      return typeof id === "string" ? [{ id, parentID: part.sessionID }] : []
    }),
  ]
  while (true) {
    const children = links.filter(
      (item) => item.parentID && descendants.has(item.parentID) && !descendants.has(item.id),
    )
    if (!children.length) break
    children.forEach((item) => descendants.add(item.id))
  }
  const agents = new Map<string, { id: string; title: string }>()
  tasks.forEach((part) => {
    if (!("metadata" in part.state)) return
    const metadata = part.state.metadata
    if (metadata?.background !== true || typeof metadata.sessionId !== "string") return
    if (!descendants.has(part.sessionID)) return
    const status = data.session_status[metadata.sessionId]
    if (!status || status.type === "idle") return
    agents.set(metadata.sessionId, {
      id: metadata.sessionId,
      title: "title" in part.state ? (part.state.title ?? "Background agent") : "Background agent",
    })
  })
  return {
    agents: Array.from(agents.values()),
    shells: tools.filter(
      (part) =>
        (part.tool === "bash" || part.tool === "shell") &&
        descendants.has(part.sessionID) &&
        ("metadata" in part.state && part.state.metadata?.background === true
          ? part.state.metadata.shellStatus === "running"
          : part.state.status === "running" && data.session_status[part.sessionID]?.type !== "idle"),
    ),
  }
}

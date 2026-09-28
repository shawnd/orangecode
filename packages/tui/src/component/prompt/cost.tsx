import { RGBA } from "@opentui/core"
import type { Session } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useSDK } from "../../context/sdk"
import { sessionTotalCost } from "../../util/session-cost"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export function useSessionCostChildren(sessionID: () => string | undefined) {
  const sdk = useSDK()
  const [subagents, setSubagents] = createSignal<Session[]>([])
  createEffect(() => {
    const id = sessionID()
    setSubagents([])
    if (!id) return
    let cancelled = false
    const load = async () => {
      const sessions: Session[] = []
      const pending = [id]
      while (pending.length && !cancelled) {
        const children = (
          await Promise.all(pending.splice(0, 10).map((parent) => sdk.client.session.children({ sessionID: parent })))
        ).flatMap((result) => result.data ?? [])
        sessions.push(...children)
        pending.push(...children.map((child) => child.id))
        if (!cancelled) setSubagents([...sessions])
      }
    }
    void load().catch(() => {})
    onCleanup(() => {
      cancelled = true
    })
  })
  return subagents
}

export function SessionCost(props: {
  sessionID?: string
  sessionCost?: number
  sessions: readonly { id: string; parentID?: string; cost?: number }[]
  historical?: readonly { id: string; parentID?: string; cost?: number }[]
  color: RGBA
}) {
  const [scope, setScope] = createSignal<"total" | "session">("total")
  const total = createMemo(() =>
    props.sessionID ? sessionTotalCost(props.sessionID, props.sessions, props.historical) : 0,
  )

  return (
    <text
      fg={props.color}
      wrapMode="none"
      onMouseUp={() => setScope((current) => (current === "total" ? "session" : "total"))}
    >
      {` · ${scope()} ${money.format(scope() === "total" ? total() : (props.sessionCost ?? 0))}`}
    </text>
  )
}

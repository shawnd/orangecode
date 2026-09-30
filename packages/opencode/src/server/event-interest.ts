import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"

type Envelope = {
  payload: {
    type: string
    properties?: unknown
    syncEvent?: { type: string; aggregateID: string; data: unknown }
  }
}

// Explicit allow-list: new metadata events must remain globally visible by default.
const transcript = new Set([
  "message.updated", "message.removed", "message.part.updated", "message.part.delta", "message.part.removed",
  "todo.updated", "session.diff",
  "session.next.agent.switched", "session.next.model.switched", "session.next.prompted", "session.next.prompt.admitted",
  "session.next.context.updated", "session.next.synthetic", "session.next.shell.started", "session.next.shell.ended",
  "session.next.step.started", "session.next.step.ended", "session.next.step.failed",
  "session.next.text.started", "session.next.text.delta", "session.next.text.ended",
  "session.next.reasoning.started", "session.next.reasoning.delta", "session.next.reasoning.ended",
  "session.next.tool.input.started", "session.next.tool.input.delta", "session.next.tool.input.ended",
  "session.next.tool.called", "session.next.tool.progress", "session.next.tool.success", "session.next.tool.failed",
  "session.next.retried", "session.next.compaction.started", "session.next.compaction.delta", "session.next.compaction.ended",
])

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}
}

export function makeEventInterest(sessions: string) {
  const roots = new Set(sessions.split(",").filter(Boolean))
  const interested = new Set(roots)
  return {
    // Seed only interested branches, rather than retaining every server Session.
    seed(db: Database.Interface["db"]) {
      if (roots.size === 0) return Effect.void
      return db.all<{ id: string }>(sql`
        WITH RECURSIVE interested(id) AS (
          SELECT id FROM session WHERE id IN (${sql.join([...roots].map((id) => sql`${id}`), sql`, `)})
          UNION SELECT session.id FROM session JOIN interested ON session.parent_id = interested.id
        ) SELECT id FROM interested
      `).pipe(Effect.tap((rows) => Effect.sync(() => rows.forEach((row) => interested.add(row.id)))), Effect.asVoid, Effect.orDie)
    },
    accepts(event: Envelope) {
      const payload = event.payload
      const type = payload.type === "sync" && payload.syncEvent ? payload.syncEvent.type.replace(/\.\d+$/, "") : payload.type
      const data = record(payload.type === "sync" ? payload.syncEvent?.data : payload.properties)
      const info = record(data.info)
      if (type === "session.created" || type === "session.updated") {
        if (typeof info.id === "string" && typeof info.parentID === "string" && interested.has(info.parentID)) interested.add(info.id)
      }
      if (type === "session.deleted" && typeof info.id === "string" && !roots.has(info.id)) interested.delete(info.id)
      if (!transcript.has(type)) return true
      const id = data.sessionID ?? record(data.info).sessionID ?? record(data.part).sessionID ?? payload.syncEvent?.aggregateID
      return typeof id === "string" && interested.has(id)
    },
  }
}

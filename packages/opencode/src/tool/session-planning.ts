import { and, desc, eq, isNull, ne } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "./tool"

export const Parameters = Schema.Struct({
  include_self: Schema.optional(Schema.Boolean).annotate({
    description: "Include the session calling this tool (default false)",
  }),
})

export const SessionPlanningTool = Tool.define(
  "session_planning",
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return {
      description:
        "Use when asked which sessions have plans or planned work that may still need implementation. Lists unarchived sessions in the current project whose selected agent is `plan`; this identifies plan-mode sessions and does not inspect plan files or todo lists. Results include the session ID, title, and directory so you can use session_switch to open one. The current session is excluded by default; set include_self to true to include it.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const sessions = yield* db
            .select({
              id: SessionTable.id,
              title: SessionTable.title,
              directory: SessionTable.directory,
            })
            .from(SessionTable)
            .where(
              and(
                eq(SessionTable.project_id, instance.project.id),
                eq(SessionTable.agent, "plan"),
                isNull(SessionTable.time_archived),
                params.include_self ? undefined : ne(SessionTable.id, ctx.sessionID),
              ),
            )
            .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
            .all()
            .pipe(Effect.orDie)
          return {
            title: `Plan-mode sessions: ${sessions.length}`,
            metadata: { sessions: sessions.length },
            output: sessions.length
              ? sessions.map((session) => `${session.title} (${session.id})\n  ${session.directory}`).join("\n\n")
              : "No unarchived plan-mode sessions found in this project.",
          }
        }),
    }
  }),
)

import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { NotFoundError } from "@/storage/storage"
import { TuiEvent } from "@/server/tui-event"
import { Tool } from "./tool"

export const Parameters = Schema.Struct({
  sessionID: SessionID.annotate({ description: "ID of the previous session to open, for example from session_search" }),
})

export const SessionSwitchTool = Tool.define(
  "session_switch",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const events = yield* EventV2Bridge.Service
    return {
      description:
        "Open another session in the TUI. Use a session ID from session_search. This navigates the UI; it does not move the current agent turn or its messages into the target session. After switching, finish this turn so the user can continue there.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const target = yield* sessions
            .get(params.sessionID)
            .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
          if (!target || target.projectID !== instance.project.id)
            return {
              title: "Session not found",
              output: `Session ${params.sessionID} was not found in this project.`,
              metadata: { switched: false, sessionID: params.sessionID },
            }
          if (target.id === ctx.sessionID)
            return {
              title: `Already in ${target.title}`,
              output: `Already in ${target.title} (${target.id}).`,
              metadata: { switched: false, sessionID: target.id },
            }
          yield* events.publish(TuiEvent.SessionSelect, { sessionID: target.id })
          return {
            title: `Opened ${target.title}`,
            output: `Switched the TUI to ${target.title} (${target.id}). Continue the conversation there.`,
            metadata: { switched: true, sessionID: target.id },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

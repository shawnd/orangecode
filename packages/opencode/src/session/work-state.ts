import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionWorkState } from "@opencode-ai/core/session/work-state"
import { BackgroundJob } from "@/background/job"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { MessageID, SessionID } from "./schema"
import { SessionStatus } from "./status"
import { NotFoundError } from "@/storage/storage"

export const Info = SessionWorkState.Info
export type Info = SessionWorkState.Info

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info, Session.NotFound>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionWorkState") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const store = yield* SessionStore.Service
    const status = yield* SessionStatus.Service
    const jobs = yield* BackgroundJob.Service
    const permission = yield* Permission.Service
    const question = yield* Question.Service
    const database = yield* Database.Service

    return Service.of({
      get: Effect.fn("SessionWorkState.get")(function* (sessionID) {
        yield* sessions.get(sessionID)
        const members = new Set((yield* store.family(sessionID)).map((session) => session.id))
        const requests = [...(yield* permission.list()), ...(yield* question.list())].filter((request) =>
          members.has(request.sessionID),
        )
        // Aborted tools can leave pending requests behind. They no longer need input.
        const blocked = yield* Effect.filter(requests, (request) => {
          if (!request.tool) return Effect.succeed(true)
          const tool = request.tool
          return MessageV2.get({ sessionID: request.sessionID, messageID: MessageID.make(tool.messageID) }).pipe(
            Effect.map((message) => {
              const part = message.parts.find((part) => part.type === "tool" && part.callID === tool.callID)
              return part?.type === "tool" && (part.state.status === "pending" || part.state.status === "running")
            }),
            Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(false)),
            Effect.provideService(Database.Service, database),
          )
        })
        return SessionWorkState.summarize({
          sessionID,
          members,
          active: new Set([...(yield* status.list())].filter(([, status]) => status.type !== "idle").map(([id]) => id)),
          jobs: yield* jobs.list(),
          blocked: blocked.map((request) => request.sessionID),
        })
      }),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Database.node,
    Session.node,
    SessionStore.node,
    SessionStatus.node,
    BackgroundJob.node,
    Permission.node,
    Question.node,
  ],
})

export * as SessionWorkState from "./work-state"

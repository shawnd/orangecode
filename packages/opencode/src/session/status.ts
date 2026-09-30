import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { SessionActivity } from "@opencode-ai/core/session/activity"

export const Info = SessionStatusEvent.Info
export type Info = SessionStatusEvent.Info

export const Event = SessionStatusEvent

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const activity = yield* SessionActivity.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(function* () {
        const data = new Map<SessionID, Info>()
        yield* Effect.addFinalizer(() =>
          Effect.forEach(data.keys(), (sessionID) => activity.set(sessionID, { type: "idle" }), { discard: true }),
        )
        return data
      }),
    )

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.get(sessionID) ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map(yield* InstanceState.get(state))
    })

    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
      const data = yield* InstanceState.get(state)
      yield* events.publish(Event.Status, { sessionID, status })
      const instance = yield* InstanceState.context
      yield* activity.set(sessionID, status, instance.directory)
      if (status.type === "idle") {
        yield* events.publish(Event.Idle, { sessionID })
        data.delete(sessionID)
        return
      }
      data.set(sessionID, status)
    }, Effect.uninterruptible)

    return Service.of({ get, list, set })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, SessionActivity.node] })

export * as SessionStatus from "./status"

export * as SessionWork from "./work"

import { Context, Effect, Layer, RcMap } from "effect"
import { BackgroundJob } from "../background-job"
import { makeGlobalNode } from "../effect/app-node"
import { LocationServiceMap } from "../location-service-map"
import type { LocationError } from "../location-services"
import { PermissionV2 } from "../permission"
import { QuestionV2 } from "../question"
import { SessionV2 } from "../session"
import { SessionExecution } from "./execution"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"
import { SessionWorkState } from "./work-state"

export interface Interface {
  readonly get: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionWorkState.Info, SessionV2.NotFoundError | LocationError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionWork") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const execution = yield* SessionExecution.Service
    const locations = yield* LocationServiceMap.Service
    const jobs = yield* BackgroundJob.Service

    return Service.of({
      get: Effect.fn("SessionWork.get")(function* (sessionID) {
        const family = yield* store.family(sessionID)
        if (!family.length) return yield* new SessionV2.NotFoundError({ sessionID })
        const refs = new Set(
          family.map((session) => JSON.stringify([session.location.directory, session.location.workspaceID])),
        )
        // Pending prompts only exist in materialized Locations. Observing activity
        // must not boot historical Locations or recreate execution infrastructure.
        const live = [...(yield* RcMap.keys(locations.rcMap))].filter((ref) =>
          refs.has(JSON.stringify([ref.directory, ref.workspaceID])),
        )
        const blocked = yield* Effect.forEach(
          live,
          (ref) =>
            Effect.gen(function* () {
              const permission = yield* PermissionV2.Service
              const question = yield* QuestionV2.Service
              return [...(yield* permission.list()), ...(yield* question.list())].map((request) => request.sessionID)
            }).pipe(Effect.provide(locations.get(ref))),
          { concurrency: 8 },
        )
        return SessionWorkState.summarize({
          sessionID,
          members: new Set(family.map((session) => session.id)),
          active: yield* execution.active,
          jobs: yield* jobs.list(),
          blocked: blocked.flat(),
        })
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionStore.node, SessionExecution.node, LocationServiceMap.node, BackgroundJob.node],
})

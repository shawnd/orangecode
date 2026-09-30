export * as SessionActivity from "./activity"

import path from "path"
import { Clock, Context, Effect, FileSystem, Layer, Option, Schedule, Schema, Semaphore } from "effect"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { makeGlobalNode } from "../effect/app-node"
import { filesystem } from "../effect/app-node-platform"
import { Global } from "../global"
import { SessionSchema } from "./schema"

export const Info = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: SessionStatusEvent.Info,
  started: Schema.Number,
  pid: Schema.Number,
  directory: Schema.optional(Schema.String),
})
export type Info = typeof Info.Type

const Snapshot = Schema.fromJsonString(Schema.Struct({ heartbeat: Schema.Number, sessions: Schema.Array(Info) }))
const decode = Schema.decodeUnknownOption(Snapshot)
export const staleAfter = 30_000

export interface Interface {
  readonly set: (
    sessionID: SessionSchema.ID,
    status: SessionStatusEvent.Info,
    directory?: string,
  ) => Effect.Effect<void>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionActivity") {}

// Observational presence only: these files never confer execution ownership or trigger recovery.
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const global = yield* Global.Service
    const directory = path.join(global.state, "session-activity")
    const file = path.join(directory, `${process.pid}-${crypto.randomUUID()}.json`)
    const sessions = new Map<SessionSchema.ID, Info>()
    const lock = yield* Semaphore.make(1)

    const publish = Effect.gen(function* () {
      if (!sessions.size) return yield* fs.remove(file, { force: true })
      yield* fs.makeDirectory(directory, { recursive: true })
      yield* fs.writeFileString(
        `${file}.tmp`,
        JSON.stringify({ heartbeat: yield* Clock.currentTimeMillis, sessions: [...sessions.values()] }),
        { mode: 0o600 },
      )
      yield* fs.rename(`${file}.tmp`, file)
    }).pipe(Effect.catch((error) => Effect.logWarning("Failed to publish session activity", error)))

    yield* Effect.addFinalizer(() =>
      Effect.forEach([file, `${file}.tmp`], (file) => fs.remove(file, { force: true }).pipe(Effect.ignore), {
        discard: true,
      }),
    )
    yield* publish.pipe(lock.withPermit, Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkScoped)

    const set = Effect.fn("SessionActivity.set")(
      function* (sessionID: SessionSchema.ID, status: SessionStatusEvent.Info, directory?: string) {
        if (status.type === "idle") sessions.delete(sessionID)
        if (status.type !== "idle")
          sessions.set(sessionID, {
            sessionID,
            status,
            started: sessions.get(sessionID)?.started ?? (yield* Clock.currentTimeMillis),
            pid: process.pid,
            directory: directory ?? sessions.get(sessionID)?.directory,
          })
        yield* publish
      },
      lock.withPermit,
      Effect.uninterruptible,
    )

    const list = Effect.fn("SessionActivity.list")(function* () {
      const now = yield* Clock.currentTimeMillis
      const files = yield* fs.readDirectory(directory).pipe(Effect.catch(() => Effect.succeed([])))
      const snapshots = yield* Effect.forEach(
        files.filter((name) => name.endsWith(".json")),
        (name) =>
          fs.readFileString(path.join(directory, name)).pipe(
            Effect.map(decode),
            Effect.catch(() => Effect.succeed(Option.none())),
          ),
        { concurrency: 8 },
      )
      return snapshots.flatMap((snapshot) =>
        Option.isSome(snapshot) && now - snapshot.value.heartbeat < staleAfter
          ? snapshot.value.sessions.filter((session) => session.status.type !== "idle")
          : [],
      )
    })

    return Service.of({ set, list })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Global.node, filesystem] })

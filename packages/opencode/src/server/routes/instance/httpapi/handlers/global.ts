import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput } from "../groups/global"
import { EventBuffer } from "@/server/event-buffer"
import { Database } from "@opencode-ai/core/database/database"
import { makeEventInterest } from "@/server/event-interest"

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

export function eventResponse(
  bounded = false,
  observe?: Parameters<typeof EventBuffer.bufferedEvents>[0]["observe"],
  interest?: ReturnType<typeof makeEventInterest>,
  db?: Database.Interface["db"],
) {
  return Effect.gen(function* () {
    yield* Effect.logInfo("global event connected")
    const events = Stream.callback<GlobalBusEvent>((queue) => {
      let seeding = !!interest && !!db
      const pending: GlobalBusEvent[] = []
      const handler = (event: GlobalBusEvent) => {
        if (seeding) {
          pending.push(event)
          return
        }
        if (!interest || interest.accepts(event)) Queue.offerUnsafe(queue, event)
      }
      return Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => GlobalBus.on("event", handler)),
          () => Effect.sync(() => GlobalBus.off("event", handler)),
        )
        const sessions = interest && db ? yield* interest.seed(db) : undefined
        Queue.offerUnsafe(queue, {
          payload: {
            id: EventV2.ID.create(),
            type: "server.connected",
            properties: { ...(sessions ? { sessions } : {}) },
          },
        })
        seeding = false
        pending.forEach(handler)
        pending.length = 0
      })
    })
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    const boundedStream = EventBuffer.bufferedEvents<GlobalBusEvent>({
      encode: JSON.stringify,
      observe,
      subscribe(offer, stop) {
        return Effect.gen(function* () {
          let seeding = true
          let bytes = 0
          const pending: GlobalBusEvent[] = []
          const handler = (event: GlobalBusEvent) => {
            if (!seeding) {
              if (!interest || interest.accepts(event)) offer(event)
              return
            }
            // Database seeding must not create an unbounded secondary backlog.
            bytes += Buffer.byteLength(JSON.stringify(event))
            if (bytes > EventBuffer.eventBufferBudget.bytes || pending.length >= EventBuffer.eventBufferBudget.events) {
              GlobalBus.off("event", handler)
              pending.length = 0
              stop("overflow")
              return
            }
            pending.push(event)
          }
          const cleanup = yield* Effect.acquireRelease(
            Effect.sync(() => {
              GlobalBus.on("event", handler)
              const timer = setInterval(() => {
                handler({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })
              }, 10_000)
              return () => {
                clearInterval(timer)
                GlobalBus.off("event", handler)
              }
            }),
            (cleanup) => Effect.sync(cleanup),
          )
          const sessions = interest && db ? yield* interest.seed(db) : undefined
          offer({
            payload: {
              id: EventV2.ID.create(),
              type: "server.connected",
              properties: { ...(sessions ? { sessions } : {}) },
            },
          })
          seeding = false
          pending.forEach(handler)
          pending.length = 0
          return cleanup
        })
      },
      terminal: (reason) => JSON.stringify({ resync: true, reason }),
    }).pipe(
      Stream.map(
        (event): Sse.Event => ({
          _tag: "Event",
          event: event.terminal ? "opencode.resync" : "message",
          id: undefined,
          data: event.data,
        }),
      ),
    )

    return HttpServerResponse.stream(
      (bounded
        ? boundedStream
        : events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.map(eventData))
      ).pipe(
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("global event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
          ...(bounded ? { "X-Opencode-Event-Buffer": "bounded-v1" } : {}),
        },
      },
    )
  })
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()
    const database = yield* Database.Service

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* (ctx) {
      // Only recovery-aware clients negotiate limits. Legacy clients have no
      // snapshot fence and must not silently reconnect past critical events.
      return yield* eventResponse(
        ctx.request.headers["x-opencode-event-buffer"] === "bounded-v1",
        undefined,
        ctx.query.sessions === undefined ? undefined : makeEventInterest(ctx.query.sessions),
        ctx.query.sessions === undefined ? undefined : database.db,
      )
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return HttpServerResponse.jsonUnsafe(
          { success: false as const, error: "Unknown installation method" },
          { status: 400 },
        )
      }
      const target = ctx.payload.target
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ success: true as const, version: target }),
        Effect.catch((err) =>
          Effect.succeed({
            success: false as const,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      )
      if (!result.success) return HttpServerResponse.jsonUnsafe(result, { status: 500 })
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return HttpServerResponse.jsonUnsafe(result)
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handle("upgrade", upgrade)
  }),
)

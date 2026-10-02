import { NodeHttpServer } from "@effect/platform-node"
import { Database } from "@opencode-ai/core/database/database"
import { describe, expect, spyOn } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Option, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import { GlobalBus } from "../../src/bus/global"
import { EventBuffer } from "../../src/server/event-buffer"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { eventResponse, globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { makeEventInterest } from "../../src/server/event-interest"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { pollWithTimeout, testEffect } from "../lib/effect"

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.succeed(Database.Service, { get db(): never { throw new Error("Database not used by global upgrade tests") } })),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)
const seeded = testEffect(Database.layerFromPath(":memory:"))

describe("global SSE pending ancestry seed", () => {
  seeded.live("successful seed orders connected before buffered descendants and replays ancestry before filtering", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db.run(
        "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('proj_pending_seed', '/pending-seed', 0, 0, '[]')",
      )
      yield* database.db.run(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES
        ('seed_root', 'proj_pending_seed', NULL, 'root', '/pending-seed', 'root', 'test', 0, 0),
        ('seed_child', 'proj_pending_seed', 'seed_root', 'child', '/pending-seed', 'child', 'test', 0, 0)`)
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const before = GlobalBus.listenerCount("event")
      const interest = makeEventInterest("seed_root")
      const response = yield* eventResponse(
        true,
        undefined,
        {
          ...interest,
          seed: (db) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(ready, undefined)
              yield* Deferred.await(release)
              return yield* interest.seed(db)
            }),
        },
        database.db,
      )
      if (response.body._tag !== "Stream") return yield* Effect.die("Expected streaming response")
      const read = yield* response.body.stream.pipe(
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.filter((frame) => frame._tag === "Event"),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* Deferred.await(ready)
      ;[
        { type: "message.part.delta", properties: { sessionID: "unrelated", delta: "excluded" } },
        { type: "message.part.delta", properties: { sessionID: "seed_child", delta: "persisted descendant" } },
        { type: "session.created", properties: { info: { id: "live_child", parentID: "seed_child" } } },
        { type: "message.part.delta", properties: { sessionID: "live_child", delta: "live descendant" } },
      ].forEach((payload) => GlobalBus.emit("event", { payload }))
      yield* Deferred.succeed(release, undefined)
      const frames = yield* Fiber.join(read).pipe(Effect.timeout("2 seconds"))
      expect(frames.map((frame) => JSON.parse(frame.data).payload.type)).toEqual([
        "server.connected",
        "message.part.delta",
        "session.created",
        "message.part.delta",
      ])
      expect(frames[0].data).toContain('"id":"seed_child","parentID":"seed_root"')
      expect(frames[1].data).toContain("persisted descendant")
      expect(frames[3].data).toContain("live descendant")
      expect(GlobalBus.listenerCount("event")).toBe(before)
    }),
  )

  ;["bytes", "events"].forEach((limit) => {
    seeded.live(`${limit} overflow delivers resync/EOF and releases listener/timer before seed release`, () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const ready = yield* Deferred.make<void>()
        const release = Promise.withResolvers<void>()
        const interrupted = yield* Deferred.make<void>()
        const before = GlobalBus.listenerCount("event")
        // Native timers are the production boundary; observe their actual cleanup.
        const clear = spyOn(globalThis, "clearInterval")
        yield* Effect.addFinalizer(() => Effect.sync(() => clear.mockRestore()))
        yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
        const interest = makeEventInterest("root")
        const response = HttpServerResponse.toWeb(
          yield* eventResponse(
            true,
            undefined,
            {
              ...interest,
              seed: (db) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(ready, undefined)
                  yield* Effect.promise(() => release.promise)
                  return yield* interest.seed(db)
                }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
            },
            database.db,
          ),
        )
        const read = yield* Effect.promise(() => response.text()).pipe(Effect.forkScoped)
        yield* Deferred.await(ready)
        expect(GlobalBus.listenerCount("event")).toBe(before + 1)
        const event = {
          payload: {
            type: "message.part.delta",
            properties: {
              sessionID: "root",
              delta: limit === "bytes" ? "x".repeat(EventBuffer.eventBufferBudget.bytes) : "x",
            },
          },
        }
        Array.from({ length: limit === "bytes" ? 1 : EventBuffer.eventBufferBudget.events + 1 }).forEach(() => {
          GlobalBus.emit("event", event)
        })
        expect(GlobalBus.listenerCount("event")).toBe(before)
        expect(clear).toHaveBeenCalledTimes(1)
        const text = yield* Fiber.join(read).pipe(Effect.timeout("2 seconds"))
        expect(text).toContain("event: opencode.resync")
        expect(text).toContain('data: {"resync":true,"reason":"overflow"}')
        expect(text).not.toContain("server.connected")
        expect(text.match(/event: opencode.resync/g)).toHaveLength(1)
        yield* Deferred.await(interrupted).pipe(Effect.timeout("2 seconds"))
        expect(clear).toHaveBeenCalledTimes(1)
        // The native promise is still blocked throughout terminal delivery/EOF.
        release.resolve()
        yield* Effect.yieldNow
        GlobalBus.emit("event", event)
        expect(GlobalBus.listenerCount("event")).toBe(before)
        expect(clear).toHaveBeenCalledTimes(1)
      }),
    )
  })

  seeded.live("cancellation during pending seed promptly releases listener/timer and ignores late seed resolution", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const ready = yield* Deferred.make<void>()
      const release = Promise.withResolvers<void>()
      const interrupted = yield* Deferred.make<void>()
      const before = GlobalBus.listenerCount("event")
      const clear = spyOn(globalThis, "clearInterval")
      yield* Effect.addFinalizer(() => Effect.sync(() => clear.mockRestore()))
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
      const interest = makeEventInterest("root")
      const response = HttpServerResponse.toWeb(
        yield* eventResponse(
          true,
          undefined,
          {
            ...interest,
            seed: (db) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(ready, undefined)
                yield* Effect.promise(() => release.promise)
                return yield* interest.seed(db)
              }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
          },
          database.db,
        ),
      )
      if (!response.body) return yield* Effect.die("Expected streaming response")
      const reader = response.body.getReader()
      yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel()))
      const read = reader.read()
      yield* Deferred.await(ready)
      expect(GlobalBus.listenerCount("event")).toBe(before + 1)
      yield* Effect.promise(() => reader.cancel()).pipe(Effect.timeout("2 seconds"))
      expect(yield* Effect.promise(() => read)).toEqual({ value: undefined, done: true })
      yield* Deferred.await(interrupted).pipe(Effect.timeout("2 seconds"))
      expect(GlobalBus.listenerCount("event")).toBe(before)
      expect(clear).toHaveBeenCalledTimes(1)
      release.resolve()
      yield* Effect.yieldNow
      expect(GlobalBus.listenerCount("event")).toBe(before)
      expect(clear).toHaveBeenCalledTimes(1)
    }),
  )
})

describe("global HttpApi", () => {
  it.live("negotiates a bounded prefix and explicit resync before EOF", () =>
    Effect.gen(function* () {
      const before = GlobalBus.listenerCount("event")
      const response = yield* HttpClientRequest.get(GlobalPaths.event).pipe(
        HttpClientRequest.setHeader("x-opencode-event-buffer", "bounded-v1"),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      expect(response.headers["x-opencode-event-buffer"]).toBe("bounded-v1")
      const frames = yield* response.stream.pipe(
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.tap((frame) =>
          Effect.sync(() => {
            if (frame._tag !== "Event" || !frame.data.includes('"server.connected"')) return
            expect(GlobalBus.listenerCount("event")).toBe(before + 1)
            Array.from({ length: EventBuffer.eventBufferBudget.events + 1 }, (_, i) => i).forEach((i) => {
              GlobalBus.emit("event", {
                directory: "/queues-fixture",
                payload: { type: "queues-test", properties: { i } },
              })
            })
            // Subscription ends on overflow, without waiting for the reader to drain.
            expect(GlobalBus.listenerCount("event")).toBe(before)
          }),
        ),
        Stream.runCollect,
        Effect.timeout("5 seconds"),
      )
      const events = frames.filter((frame) => frame._tag === "Event")
      expect(events[0].data).toContain('"server.connected"')
      expect(events.at(-1)).toMatchObject({ event: "opencode.resync", data: '{"resync":true,"reason":"offer-failed"}' })
      expect(events.slice(1, -1).map((frame) => JSON.parse(frame.data).payload.properties.i)).toEqual(
        Array.from({ length: EventBuffer.eventBufferBudget.events }, (_, i) => i),
      )
      expect(GlobalBus.listenerCount("event")).toBe(before)
    }),
  )

  it.live("an unrecognized negotiation retains the legacy lossless stream", () =>
    Effect.gen(function* () {
      const before = GlobalBus.listenerCount("event")
      const count = EventBuffer.eventBufferBudget.events + 1
      const response = yield* HttpClientRequest.get(GlobalPaths.event).pipe(
        HttpClientRequest.setHeader("x-opencode-event-buffer", "unknown"),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      expect(response.headers["x-opencode-event-buffer"]).toBeUndefined()
      const frames = yield* response.stream.pipe(
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.tap((frame) =>
          Effect.gen(function* () {
            if (frame._tag !== "Event" || !frame.data.includes('"server.connected"')) return
            yield* pollWithTimeout(
              Effect.sync(() => (GlobalBus.listenerCount("event") === before + 1 ? true : undefined)),
              "legacy source was not installed",
            )
            Array.from({ length: count }, (_, i) => i).forEach((i) => {
              GlobalBus.emit("event", {
                directory: "/queues-fixture",
                payload: { type: "queues-test", properties: { i } },
              })
            })
          }),
        ),
        Stream.take(count + 1),
        Stream.runCollect,
        Effect.timeout("5 seconds"),
      )
      const events = frames.filter((frame) => frame._tag === "Event")
      expect(events.every((frame) => frame.event === "message")).toBe(true)
      expect(events.slice(1).map((frame) => JSON.parse(frame.data).payload.properties.i)).toEqual(
        Array.from({ length: count }, (_, i) => i),
      )
    }),
  )

  it.live("upgrades to the requested version", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: "9.9.9" }),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ success: true, version: "9.9.9" })
    }),
  )

  it.live("rejects invalid upgrade payloads", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: 1 }),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
    }),
  )

  it.live("rejects invalid upgrade target versions", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: "latest" }),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
    }),
  )

  it.live("rejects unsupported upgrade content types", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.setBody(HttpBody.text('{"target":"1.0.0"}', "text/plain")),
        HttpClient.execute,
      )

      expect(response.status).toBe(415)
    }),
  )
})

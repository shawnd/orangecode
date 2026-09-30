import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import { GlobalBus } from "../../src/bus/global"
import { EventBuffer } from "../../src/server/event-buffer"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
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
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
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

describe("global HttpApi", () => {
  it.live("negotiates a bounded prefix and explicit resync before EOF", () =>
    Effect.gen(function* () {
      const before = GlobalBus.listenerCount("event")
      const response = yield* HttpClientRequest.get(GlobalPaths.event).pipe(
        HttpClientRequest.setHeader("x-opencode-event-buffer", "bounded-v1"),
        HttpClient.execute,
      )
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

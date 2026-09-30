import { expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ShareNext } from "../../src/share/share-next"
import { Session } from "../../src/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { disposeInstance } from "../../src/effect/instance-registry"
import { provideTmpdirInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { publishSharingBatch, seedShare, sharingConfig, sharingFixture, sharingPayloads } from "./sharing-fixture"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

it.live("sharing listeners are instance-owned and init is idempotent across reloads", () =>
  provideTmpdirInstance(
    (directory) => {
      const fixture = sharingFixture()
      return Effect.gen(function* () {
        const share = yield* ShareNext.Service
        const session = yield* Session.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({ title: "reload" })
        const payload = sharingPayloads(info.id, fixture, 16)
        for (let cycle = 0; cycle < 4; cycle++) {
          yield* share.init()
          yield* share.init()
          expect(fixture.work.retained).toBe(5)
          const before = fixture.work.callbacks
          yield* events.publish(Session.Event.Diff, { sessionID: info.id, diff: payload.diff })
          expect(fixture.work.callbacks - before).toBe(5)
          yield* Effect.promise(() => disposeInstance(directory))
          expect(fixture.work.retained).toBe(0)
          const disposed = fixture.work.callbacks
          yield* publishSharingBatch(payload)
          expect(fixture.work.callbacks).toBe(disposed)
          expect(fixture.work.retained).toBe(0)
        }
      }).pipe(Effect.provide(fixture.layer))
    },
    { config: sharingConfig },
  ),
)

it.live("unshared events skip session/message/part/diff copies and user model resolution", () =>
  provideTmpdirInstance(
    () => {
      const fixture = sharingFixture()
      return Effect.gen(function* () {
        const session = yield* Session.Service
        const share = yield* ShareNext.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({ title: "private" })
        yield* share.init()
        yield* publishSharingBatch(sharingPayloads(info.id, fixture))
        yield* events.publish(Session.Event.Updated, { sessionID: info.id, info: fixture.tracked(info) })
        expect(fixture.work.clones).toBe(0)
        expect(fixture.work.models).toBe(0)
        expect(fixture.requests).toHaveLength(0)
      }).pipe(Effect.provide(fixture.layer))
    },
    { config: sharingConfig },
  ),
)

it.live("sharing eligibility follows create after a cached unshared result and ignores other directories", () =>
  provideTmpdirInstance(
    (directory) => {
      const fixture = sharingFixture()
      return Effect.gen(function* () {
        const session = yield* Session.Service
        const share = yield* ShareNext.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({ title: "initially private" })
        const payload = sharingPayloads(info.id, fixture, 16)
        yield* share.init()
        yield* publishSharingBatch(payload)
        expect(fixture.work.clones).toBe(0)
        yield* share.create(info.id)
        yield* pollWithTimeout(
          Effect.sync(() => fixture.requests.some((req) => req.url.endsWith("/sync")) || undefined),
          "missing initial full sync",
        )
        yield* events.publish(
          Session.Event.Diff,
          { sessionID: info.id, diff: payload.diff },
          {
            location: Location.Ref.make({ directory: AbsolutePath.make(`${directory}/other`) }),
          },
        )
        expect(fixture.work.clones).toBe(0)
        yield* publishSharingBatch(payload)
        expect(fixture.work.clones).toBe(3)
        yield* pollWithTimeout(
          Effect.sync(() => fixture.requests.filter((req) => req.url.endsWith("/sync")).length === 2 || undefined),
          "newly shared events did not flush",
        )
      }).pipe(Effect.provide(fixture.layer))
    },
    { config: sharingConfig },
  ),
)

it.live("shared events keep owned snapshots, coalesce parts and include user model updates", () =>
  provideTmpdirInstance(
    () => {
      const fixture = sharingFixture()
      return Effect.gen(function* () {
        const session = yield* Session.Service
        const share = yield* ShareNext.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({ title: "shared" })
        yield* seedShare(info.id)
        yield* share.init()
        const payload = sharingPayloads(info.id, fixture, 16)
        yield* publishSharingBatch(payload)
        yield* events.publish(Session.Event.Updated, { sessionID: info.id, info: fixture.tracked(info) })
        info.title = "mutated after publication"
        payload.user.agent = "mutated after publication"
        payload.diff[0].patch = "mutated after publication"
        payload.part.state.output = "latest part"
        yield* events.publish(MessageV2.Event.PartUpdated, { sessionID: info.id, part: payload.part, time: 1 })
        payload.part.state.output = "mutated after publication"
        yield* pollWithTimeout(
          Effect.sync(() => fixture.requests.length || undefined),
          "missing share flush",
        )
        expect(fixture.requests).toHaveLength(1)
        const body = JSON.parse(fixture.requests[0].body)
        expect(body.data).toHaveLength(5)
        expect(body.data.find((item: { type: string }) => item.type === "part").data.state.output).toBe("latest part")
        expect(body.data.find((item: { type: string }) => item.type === "message").data.agent).toBe("build")
        expect(body.data.find((item: { type: string }) => item.type === "session").data.title).toBe("shared")
        expect(body.data.find((item: { type: string }) => item.type === "session_diff").data[0].patch).toBe(
          "y".repeat(16),
        )
        expect(body.data.find((item: { type: string }) => item.type === "model").data[0].id).toBe("gpt-4o")
        expect(fixture.work.models).toBe(1)
      }).pipe(Effect.provide(fixture.layer))
    },
    { config: sharingConfig },
  ),
)

it.live("disposing during a user model lookup cancels the callback and pending flush", () =>
  provideTmpdirInstance(
    (directory) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const fixture = sharingFixture({
          modelGate: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
        })
        yield* Effect.gen(function* () {
          const session = yield* Session.Service
          const share = yield* ShareNext.Service
          const events = yield* EventV2Bridge.Service
          const info = yield* session.create({ title: "dispose race" })
          yield* seedShare(info.id)
          yield* share.init()
          const payload = sharingPayloads(info.id, fixture, 16)
          const publishing = yield* events
            .publish(MessageV2.Event.Updated, { sessionID: info.id, info: payload.user })
            .pipe(Effect.forkChild)
          yield* awaitWithTimeout(Deferred.await(entered), "model lookup did not start")
          yield* Effect.promise(() => disposeInstance(directory))
          yield* awaitWithTimeout(Fiber.join(publishing), "disposed callback is still waiting on model lookup")
          expect(fixture.work.retained).toBe(0)
          yield* share.init()
          expect(fixture.work.retained).toBe(5)
          yield* Deferred.succeed(gate, undefined)
          // The real one-second debounce must never send the disposed queue.
          yield* Effect.sleep(1100)
          expect(fixture.requests).toHaveLength(0)
          yield* events.publish(Session.Event.Diff, { sessionID: info.id, diff: payload.diff })
          yield* pollWithTimeout(
            Effect.sync(() => fixture.requests.length || undefined),
            "reinitialized listener did not flush",
          )
          expect(JSON.parse(fixture.requests[0].body).data.map((item: { type: string }) => item.type)).toEqual([
            "session_diff",
          ])
        }).pipe(Effect.provide(fixture.layer))
      }),
    { config: sharingConfig },
  ),
)

it.live("removing a share while model lookup is in flight does not enqueue a stale model", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const fixture = sharingFixture({
          modelGate: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
        })
        yield* Effect.gen(function* () {
          const session = yield* Session.Service
          const share = yield* ShareNext.Service
          const events = yield* EventV2Bridge.Service
          const info = yield* session.create({ title: "remove race" })
          yield* seedShare(info.id)
          yield* share.init()
          const payload = sharingPayloads(info.id, fixture, 16)
          const publishing = yield* events
            .publish(MessageV2.Event.Updated, { sessionID: info.id, info: payload.user })
            .pipe(Effect.forkChild)
          yield* awaitWithTimeout(Deferred.await(entered), "model lookup did not start")
          yield* share.remove(info.id)
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(publishing)
          yield* Effect.sleep(1100)
          expect(fixture.requests.map((req) => req.method)).toEqual(["DELETE"])
        }).pipe(Effect.provide(fixture.layer))
      }),
    { config: sharingConfig },
  ),
)

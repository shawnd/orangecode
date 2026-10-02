import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { EventBuffer } from "../../src/server/event-buffer"
import { awaitWithTimeout, it } from "../lib/effect"

describe("bounded event buffer", () => {
  it.effect("drains an ordered immutable prefix, then one terminal frame; detaches immediately", () =>
    Effect.gen(function* () {
      const state = { cleanup: 0, detachedBeforeDrain: false, peakBytes: 0, peakEvents: 0 }
      const records = yield* EventBuffer.bufferedEvents({
        budget: { bytes: 20, events: 10 },
        encode: JSON.stringify,
        terminal: (reason) => reason,
        observe: (sample) => {
          state.peakBytes = Math.max(state.peakBytes, sample.bytes)
          state.peakEvents = Math.max(state.peakEvents, sample.events)
        },
        subscribe(offer) {
          const event = { i: 1 }
          offer(event)
          event.i = 2
          offer(event)
          event.i = 3
          offer(event)
          // Subsequent offers after termination must not append after the gap.
          event.i = 4
          offer(event)
          return () => {
            state.cleanup++
          }
        },
      }).pipe(
        Stream.tap(() =>
          Effect.sync(() => {
            state.detachedBeforeDrain = state.cleanup === 1
          }),
        ),
        Stream.runCollect,
        Effect.scoped,
      )
      expect(records).toEqual([
        { data: '{"i":1}', terminal: false },
        { data: '{"i":2}', terminal: false },
        { data: "overflow", terminal: true },
      ])
      expect(state).toEqual({ cleanup: 1, detachedBeforeDrain: true, peakBytes: 14, peakEvents: 2 })
    }),
  )

  it.effect("treats a real failed bounded Queue.offerUnsafe as terminal, never as a dropped success", () =>
    Effect.gen(function* () {
      const records = yield* EventBuffer.bufferedEvents({
        budget: { bytes: 1024, events: 2 },
        encode: String,
        terminal: (reason) => reason,
        subscribe(offer) {
          ;[1, 2, 3, 4].forEach(offer)
          return () => {}
        },
      }).pipe(Stream.runCollect)
      expect(records).toEqual([
        { data: "1", terminal: false },
        { data: "2", terminal: false },
        { data: "offer-failed", terminal: true },
      ])
    }),
  )

  it.effect("counts UTF-8 bytes, and rejects an oversize singleton without retaining it", () =>
    Effect.gen(function* () {
      const samples: number[] = []
      const records = yield* EventBuffer.bufferedEvents({
        budget: { bytes: 3, events: 10 },
        encode: (event: string) => event,
        terminal: (reason) => reason,
        observe: (state) => samples.push(state.bytes),
        subscribe(offer) {
          offer("🙂")
          return () => {}
        },
      }).pipe(Stream.runCollect)
      expect(records).toEqual([{ data: "overflow", terminal: true }])
      expect(Math.max(...samples)).toBe(0)
    }),
  )

  it.effect("reports overflow even when take was already waiting on an empty queue", () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<(event: string) => void>()
      const state = { cleanup: 0 }
      const reader = yield* EventBuffer.bufferedEvents({
        budget: { bytes: 2, events: 10 },
        encode: (event: string) => event,
        terminal: (reason) => reason,
        subscribe(offer) {
          Deferred.doneUnsafe(ready, Effect.succeed(offer))
          return () => {
            state.cleanup++
          }
        },
      }).pipe(Stream.runCollect, Effect.forkScoped)
      const offer = yield* Deferred.await(ready)
      yield* Effect.yieldNow
      offer("oversize")
      expect(state.cleanup).toBe(1)
      expect(yield* Fiber.join(reader)).toEqual([{ data: "overflow", terminal: true }])
    }),
  )

  it.effect("consumer cancellation detaches an idle subscription exactly once", () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const state = { cleanup: 0, bytes: -1, events: -1 }
      const reader = yield* EventBuffer.bufferedEvents({
        encode: String,
        terminal: (reason) => reason,
        subscribe() {
          Deferred.doneUnsafe(ready, Effect.void)
          return () => {
            state.cleanup++
          }
        },
        observe(sample) {
          state.bytes = sample.bytes
          state.events = sample.events
        },
      }).pipe(Stream.runDrain, Effect.forkScoped)
      yield* Deferred.await(ready)
      yield* Fiber.interrupt(reader)
      expect(state).toEqual({ cleanup: 1, bytes: 0, events: 0 })
    }),
  )

  it.effect("early consumer close releases queued state without fabricating a gap", () =>
    Effect.gen(function* () {
      const state = { cleanup: 0, bytes: -1, events: -1 }
      const records = yield* EventBuffer.bufferedEvents({
        encode: String,
        terminal: (reason) => reason,
        subscribe(offer) {
          offer(1)
          offer(2)
          return () => {
            state.cleanup++
          }
        },
        observe(sample) {
          state.bytes = sample.bytes
          state.events = sample.events
        },
      }).pipe(Stream.take(1), Stream.runCollect, Effect.scoped)
      expect(records).toEqual([{ data: "1", terminal: false }])
      expect(state).toEqual({ cleanup: 1, bytes: 0, events: 0 })
    }),
  )

  it.effect("cancellation during effectful subscription releases its acquired listener", () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const state = { cleanup: 0 }
      const reader = yield* EventBuffer.bufferedEvents<string>({
        encode: String,
        terminal: (reason) => reason,
        subscribe() {
          return Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => Deferred.doneUnsafe(ready, Effect.void)),
              () => Effect.sync(() => state.cleanup++),
            )
            yield* Effect.never
            return () => {}
          })
        },
      }).pipe(Stream.runDrain, Effect.forkScoped)
      yield* Deferred.await(ready)
      yield* Fiber.interrupt(reader)
      expect(state.cleanup).toBe(1)
    }),
  )

  it.effect("overflow while subscription is blocked drains its prefix and terminal before acquisition returns", () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<(event: string) => void>()
      const state = { cleanup: 0 }
      const reader = yield* EventBuffer.bufferedEvents<string>({
        budget: { bytes: 2, events: 10 },
        encode: String,
        terminal: String,
        subscribe(offer) {
          return Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => Deferred.doneUnsafe(ready, Effect.succeed(offer))),
              () => Effect.sync(() => state.cleanup++),
            )
            yield* Effect.never
            return () => {}
          })
        },
      }).pipe(Stream.runCollect, Effect.forkScoped)
      const offer = yield* Deferred.await(ready)
      offer("a")
      offer("oversize")
      expect(yield* awaitWithTimeout(Fiber.join(reader), "terminal waited for subscription")).toEqual([
        { data: "a", terminal: false },
        { data: "overflow", terminal: true },
      ])
      expect(state.cleanup).toBe(1)
    }),
  )

  it.effect("late asynchronous acquisition after cancellation cleans up once and cannot offer more events", () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const closed = yield* Deferred.make<void>()
      const state = { cleanup: 0, events: 0 }
      const reader = yield* EventBuffer.bufferedEvents<string>({
        encode: String,
        terminal: String,
        observe(sample) {
          state.events = sample.events
          if (sample.events === 0) Deferred.doneUnsafe(closed, Effect.void)
        },
        subscribe(offer) {
          return Effect.gen(function* () {
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(release)
            offer("late")
            return () => {
              state.cleanup++
            }
          }).pipe(Effect.uninterruptible)
        },
      }).pipe(Stream.runDrain, Effect.forkScoped)
      yield* Deferred.await(ready)
      const cancellation = yield* Fiber.interrupt(reader).pipe(Effect.forkScoped)
      yield* awaitWithTimeout(Deferred.await(closed), "buffer admission did not close before interruption")
      yield* Deferred.succeed(release, undefined)
      yield* awaitWithTimeout(Fiber.join(cancellation), "late cleanup did not complete")
      expect(state).toEqual({ cleanup: 1, events: 0 })
    }),
  )

  it.effect("an asynchronous subscription defect fails the pull instead of leaving it blocked", () =>
    Effect.gen(function* () {
      const exit = yield* EventBuffer.bufferedEvents<string>({
        encode: String,
        terminal: String,
        subscribe: () => Effect.die("seed failed"),
      }).pipe(Stream.runCollect, Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )
})

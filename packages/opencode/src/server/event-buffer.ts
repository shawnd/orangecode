import { Cause, Effect, Pull, Queue, Stream } from "effect"

export const eventBufferBudget = { bytes: 4 * 1024 * 1024, events: 4096 }

type BufferedEvent = { data: string; terminal: boolean }

// Retain serialized payloads, not mutable bus objects. A failed offer ends the
// subscription; it must never be interpreted as a successful, dropped event.
export function bufferedEvents<A>(input: {
  subscribe: (offer: (event: A) => void) => () => void
  encode: (event: A) => string
  terminal: (reason: "overflow" | "offer-failed") => string
  budget?: typeof eventBufferBudget
  observe?: (state: { bytes: number; events: number; reason?: string }) => void
}) {
  return Stream.fromPull(
    Effect.gen(function* () {
      const budget = input.budget ?? eventBufferBudget
      if (
        !Number.isSafeInteger(budget.bytes) ||
        budget.bytes <= 0 ||
        !Number.isSafeInteger(budget.events) ||
        budget.events <= 0
      ) {
        return yield* Effect.die(new RangeError("Event buffer budgets must be positive safe integers"))
      }
      const queue = yield* Queue.bounded<{ data: string; bytes: number }, Cause.Done>(budget.events)
      const state = { bytes: 0, events: 0, reason: undefined as "overflow" | "offer-failed" | undefined }
      let unsubscribe: (() => void) | undefined
      let closed = false
      let terminal = false
      const detach = () => {
        const cleanup = unsubscribe
        unsubscribe = undefined
        cleanup?.()
      }
      const stop = (reason: "overflow" | "offer-failed") => {
        if (closed || state.reason) return
        state.reason = reason
        detach()
        Queue.endUnsafe(queue)
        input.observe?.(state)
      }
      const offer = (event: A) => {
        if (closed || state.reason) return
        const data = input.encode(event)
        const bytes = Buffer.byteLength(data)
        if (bytes + state.bytes > budget.bytes) {
          stop("overflow")
          return
        }
        if (!Queue.offerUnsafe(queue, { data, bytes })) {
          stop("offer-failed")
          return
        }
        state.bytes += bytes
        state.events++
        input.observe?.(state)
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const cleanup = input.subscribe(offer)
          // A synchronous source can overflow before subscribe returns.
          if (state.reason) cleanup()
          if (!state.reason) unsubscribe = cleanup
        }),
        () =>
          Effect.gen(function* () {
            closed = true
            detach()
            yield* Queue.shutdown(queue)
            state.bytes = 0
            state.events = 0
            input.observe?.(state)
          }),
      )
      return Effect.gen(function* () {
        const event = yield* Queue.take(queue)
        state.bytes -= event.bytes
        state.events--
        input.observe?.(state)
        const record: BufferedEvent = { data: event.data, terminal: false }
        return [record] as const
      }).pipe(
        Pull.catchDone(() => {
          // The producer may end the queue while the reader is already waiting
          // in take. Catch completion here so even an oversize first event yields
          // an explicit terminal record rather than an apparently clean EOF.
          if (!state.reason || terminal) return Cause.done()
          terminal = true
          return Effect.succeed<readonly [BufferedEvent]>([{ data: input.terminal(state.reason), terminal: true }])
        }),
      )
    }),
  ).pipe(Stream.scoped)
}

export * as EventBuffer from "./event-buffer"

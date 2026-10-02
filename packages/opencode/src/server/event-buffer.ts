import { Cause, Effect, Fiber, Pull, Queue, Scope, Stream } from "effect"

export const eventBufferBudget = { bytes: 4 * 1024 * 1024, events: 4096 }

type BufferedEvent = { data: string; terminal: boolean }

// Retain serialized payloads, not mutable bus objects. A failed offer ends the
// subscription; it must never be interpreted as a successful, dropped event.
export function bufferedEvents<A>(input: {
  subscribe: (
    offer: (event: A) => void,
    stop: (reason: "overflow" | "offer-failed") => void,
  ) => (() => void) | Effect.Effect<() => void, never, Scope.Scope>
  encode: (event: A) => string
  terminal: (reason: "overflow" | "offer-failed") => string
  budget?: typeof eventBufferBudget
  observe?: (state: { bytes: number; events: number; reason?: string }) => void
}) {
  // Register teardown atomically: subscribe can signal readiness and trigger
  // consumer cancellation before it returns. Only setup is uninterruptible.
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
      let subscriber: Fiber.Fiber<void> | undefined
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
        subscriber?.interruptUnsafe()
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
      const install = (cleanup: () => void) => {
        // Also reconcile a subscription that completes after stop/cancellation.
        if (closed || state.reason) cleanup()
        if (!closed && !state.reason) unsubscribe = cleanup
      }
      const subscription = input.subscribe(offer, stop)
      if (!Effect.isEffect(subscription)) install(subscription)
      if (Effect.isEffect(subscription)) {
        // Acquisition must not gate the pull: a blocked seed can overflow before
        // it returns its cleanup. Keep its scoped resources alive until teardown.
        subscriber = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            install(yield* restore(subscription))
            yield* restore(Effect.never)
          }),
        ).pipe(
          Effect.scoped,
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              if (!closed && !state.reason) Queue.failCauseUnsafe(queue, cause)
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )
        if (state.reason) subscriber.interruptUnsafe()
      }
      // Close admission before the scoped subscriber is interrupted, including
      // when its acquisition only returns a cleanup after cancellation.
      yield* Effect.addFinalizer(() =>
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
    }).pipe(Effect.uninterruptible),
  ).pipe(Stream.scoped)
}

export * as EventBuffer from "./event-buffer"

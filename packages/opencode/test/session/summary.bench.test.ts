import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { SessionSummary } from "@/session/summary"
import { fixture, seed, finish, inInstance, sessionID, messageID } from "./summary-fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
console.log("SUMMARY_LOCK_WAIT_MS", Date.now() - Number(process.env.SUMMARY_LOCK_REQUEST_MS ?? Date.now()))

it.live(
  "real SessionSummary burst benchmark",
  () =>
    Effect.gen(function* () {
      const results = yield* Effect.forEach([0, 1, 2, 3], (trial) =>
        Effect.gen(function* () {
          const f = yield* fixture
          return yield* Effect.gen(function* () {
            yield* seed(120)
            yield* f.listen
            const summary = yield* SessionSummary.Service
            f.control.blocked = true
            const start = performance.now()
            yield* f.measure(
              Effect.gen(function* () {
                const first = yield* summary.summarize({ sessionID, messageID }).pipe(Effect.forkScoped)
                yield* f.entered.await
                const burst = yield* Effect.forEach(Array.from({ length: 24 }), (_, i) =>
                  finish(`latest-${i}`, i).pipe(
                    Effect.andThen(summary.summarize({ sessionID, messageID })),
                    Effect.forkScoped,
                  ),
                )
                // Simulate a busy snapshot lock while step completions accumulate.
                yield* Effect.sleep("50 millis")
                yield* f.release.open
                yield* Fiber.join(first)
                yield* Effect.forEach(burst, Fiber.join)
                for (let i = 0; i < 8; i++) yield* summary.summarize({ sessionID, messageID })
              }),
            )
            const elapsedMs = performance.now() - start
            const diff = yield* summary.diff({ sessionID, messageID })
            expect(diff[0]?.patch).toBe("from -> latest-23")
            return { trial, warmup: trial === 0, elapsedMs, ...f.metrics, pairs: f.pairs }
          }).pipe(inInstance, Effect.scoped, Effect.provide(f.layer))
        }),
      )
      console.log(
        "SUMMARY_BENCH",
        JSON.stringify({ historyTurns: 120, messages: 242, parts: 1234, burst: 24, repeats: 8, results }),
      )
      const output = process.env.SUMMARY_RESULTS
      if (output) yield* Effect.promise(() => Bun.write(output, JSON.stringify(results, null, 2)))
    }),
  120000,
)

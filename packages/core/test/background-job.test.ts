import { describe, expect } from "bun:test"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { it } from "./lib/effect"
import { unlink } from "node:fs/promises"

const jobsLayer = LayerNode.compile(BackgroundJob.node)

describe("BackgroundJob", () => {
  it.live("releases only acknowledged terminal payloads and preserves late waiters and snapshots", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.make
      const latch = yield* Deferred.make<void>()
      const output = "late-output".repeat(3000)
      const path = `/tmp/opencode/server-jobs-core-${process.pid}.tail`
      yield* Effect.acquireRelease(
        Effect.promise(() => Bun.write(path, output)),
        () => Effect.promise(() => unlink(path)),
      )
      const load = Effect.promise(() => Bun.file(path).text())
      const job = yield* jobs.start({ type: "test", run: Deferred.await(latch).pipe(Effect.as(output)) })
      expect(yield* jobs.acknowledge(job.id, load)).toBe(false)
      const waiting = yield* jobs.wait({ id: job.id }).pipe(Effect.forkScoped)
      yield* Deferred.succeed(latch, undefined)
      const completed = yield* jobs.wait({ id: job.id })
      if (!completed.info) throw new Error("Completed job disappeared before acknowledgement")
      expect(yield* jobs.acknowledge(job.id, load)).toBe(true)
      expect(yield* jobs.wait({ id: job.id })).toEqual(completed)
      expect(yield* jobs.get(job.id)).toEqual(completed.info)
      expect(yield* jobs.cancel(job.id)).toEqual(completed.info)
      expect(yield* jobs.list()).toEqual([completed.info])
      expect(yield* Fiber.join(waiting)).toEqual(completed)
      expect(yield* jobs.extend({ id: job.id, run: Effect.succeed("no") })).toBe(false)
      expect(yield* jobs.acknowledge("missing", load)).toBe(false)
    }),
  )
  it.live("tracks process-local work through explicit observation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        metadata: { durable: false },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job).toMatchObject({ type: "test", status: "running", metadata: { durable: false } })
      expect(yield* jobs.wait({ id: job.id, timeout: 0 })).toMatchObject({
        timedOut: true,
        info: { status: "running" },
      })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("publishes jobs before starting immediately settling work", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) => {
        const id = `job_immediate_start_${index}`
        return Effect.gen(function* () {
          const job = yield* jobs.start({
            id,
            type: "test",
            run: jobs
              .get(id)
              .pipe(
                Effect.flatMap((info) =>
                  info?.status === "running"
                    ? Effect.succeed(`done-${index}`)
                    : Effect.fail("job started before publish"),
                ),
              ),
          })

          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `done-${index}` },
          })
        })
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("increments pending work before starting immediately settling extensions", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) =>
        Effect.gen(function* () {
          const first = yield* Deferred.make<void>()
          const job = yield* jobs.start({
            type: "test",
            run: Deferred.await(first).pipe(Effect.as(`first-${index}`)),
          })

          expect(yield* jobs.extend({ id: job.id, run: Effect.succeed(`second-${index}`) })).toBe(true)
          expect((yield* jobs.get(job.id))?.status).toBe("running")

          yield* Deferred.succeed(first, undefined)
          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `second-${index}` },
          })
        }),
      )
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("interrupts live work without promising settlement after the owning process-local scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* BackgroundJob.make.pipe(Scope.provide(scope))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      yield* Scope.close(scope, Exit.void)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      // The abandoned in-memory registry is not a durable observation channel.
      expect((yield* jobs.get(job.id))?.status).toBe("running")
    }),
  )
})

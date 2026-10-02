import { describe, expect } from "bun:test"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { it } from "./lib/effect"
import { unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const jobsLayer = LayerNode.compile(BackgroundJob.node)

describe("BackgroundJob", () => {
  it.live("releases only acknowledged terminal payloads and preserves late waiters and snapshots", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.make
      const latch = yield* Deferred.make<void>()
      const output = "late-output".repeat(3000)
      const file = path.join(os.tmpdir(), `server-jobs-core-${process.pid}.tail`)
      yield* Effect.acquireRelease(
        Effect.promise(() => Bun.write(file, output)),
        () => Effect.promise(() => unlink(file)),
      )
      const load = Effect.promise(() => Bun.file(file).text())
      const job = yield* jobs.start({ type: "test", run: Deferred.await(latch).pipe(Effect.as(output)) })
      expect(yield* jobs.acknowledge(job.id, load)).toBe(false)
      const waiting = yield* jobs.wait({ id: job.id }).pipe(Effect.forkScoped)
      yield* Deferred.succeed(latch, undefined)
      const completed = yield* jobs.wait({ id: job.id })
      if (!completed.info) throw new Error("Completed job disappeared before acknowledgement")
      expect(yield* jobs.acknowledge(job.id, load)).toBe(true)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject(completed)
      expect(yield* jobs.get(job.id)).toMatchObject({ ...completed.info, outputAvailability: "available" })
      expect(yield* jobs.cancel(job.id)).toMatchObject(completed.info)
      expect(yield* jobs.list()).toMatchObject([{ id: job.id, status: "completed", outputAvailability: "archived" }])
      expect((yield* jobs.list())[0].output).toBeUndefined()
      expect(yield* Fiber.join(waiting)).toMatchObject(completed)
      expect(yield* jobs.extend({ id: job.id, run: Effect.succeed("no") })).toBe(false)
      expect(yield* jobs.acknowledge("missing", load)).toBe(false)
    }),
  )
  it.live("lists without historical reads and distinguishes expiry from retryable archive failures", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.make
      let reads = 0
      const old = yield* jobs.start({ type: "test", run: Effect.succeed("old") })
      yield* jobs.wait({ id: old.id })
      yield* jobs.acknowledge(old.id, {
        load: Effect.sync(() => {
          reads++
          throw new Error("archive read failed")
        }),
        expiresAt: Date.now() + 10000,
      })
      const live = yield* jobs.start({ type: "test", run: Effect.never })
      expect((yield* jobs.list()).find((job) => job.id === old.id)?.outputAvailability).toBe("archived")
      expect(reads).toBe(0)
      expect((yield* jobs.cancel(live.id))?.status).toBe("cancelled")
      expect(yield* jobs.get(old.id)).toMatchObject({
        status: "completed",
        outputAvailability: "unavailable",
        outputError: "archive read failed",
      })
      const expired = yield* jobs.start({ type: "test", run: Effect.succeed("expired") })
      yield* jobs.wait({ id: expired.id })
      yield* jobs.acknowledge(expired.id, { load: Effect.never, expiresAt: Date.now() - 1 })
      expect((yield* jobs.get(expired.id))?.outputAvailability).toBe("expired")
      const missing = yield* jobs.start({ type: "test", run: Effect.succeed("missing") })
      yield* jobs.wait({ id: missing.id })
      yield* jobs.acknowledge(missing.id, Effect.succeed(undefined))
      expect((yield* jobs.wait({ id: missing.id })).info?.outputAvailability).toBe("expired")
      expect(reads).toBe(1)
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

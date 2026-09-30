import { expect } from "bun:test"
import { Effect, Layer, Fiber, Exit, Cause, Scope, Latch } from "effect"
import { CurrentTransformer } from "effect/unstable/sql/Statement"
import { SessionSummary } from "@/session/summary"
import { Session } from "@/session/session"
import { fixture, seed, finish, inInstance, instance, sessionID, messageID, assistantID } from "./summary-fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { Snapshot } from "@/snapshot"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { eq, sql } from "drizzle-orm"
import { provideTmpdirInstance } from "../fixture/fixture"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance } from "@/effect/instance-registry"
import { MessageID, PartID, SessionID } from "@/session/schema"

const it = testEffect(Layer.empty)

it.live("summarizes a turn and retains user summary fields", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* Effect.gen(function* () {
      yield* seed(1)
      const summary = yield* SessionSummary.Service
      const sessions = yield* Session.Service
      yield* summary.summarize({ sessionID, messageID })
      expect(yield* summary.diff({ sessionID, messageID })).toEqual([
        { file: "file.txt", patch: "from -> initial", additions: 1, deletions: 0, status: "modified" },
      ])
      const messages = yield* sessions.messages({ sessionID })
      expect(messages.find((m) => m.info.id === messageID)?.info.summary).toMatchObject({
        title: "Retained title",
        body: "Retained body",
      })
    }).pipe(inInstance, Effect.scoped, Effect.provide(f.layer))
  }),
)

it.live(
  "real Snapshot integration preserves a cumulative file diff",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* provideTmpdirInstance(
        (directory) =>
          Effect.gen(function* () {
            yield* seed()
            const snapshot = yield* Snapshot.Service
            const database = yield* Database.Service
            const summary = yield* SessionSummary.Service
            yield* Effect.promise(() => Bun.write(`${directory}/file.txt`, "before\n"))
            const from = yield* snapshot.track()
            yield* Effect.promise(() => Bun.write(`${directory}/file.txt`, "after\n"))
            const to = yield* snapshot.track()
            expect(from).toBeTruthy()
            expect(to).toBeTruthy()
            yield* database.db
              .update(PartTable)
              .set({
                data: sql`json_set(data, '$.snapshot', ${from})`,
              })
              .where(sql`json_extract(data, '$.type') = 'step-start'`)
              .run()
            yield* database.db
              .update(PartTable)
              .set({
                data: sql`json_set(data, '$.snapshot', ${to})`,
              })
              .where(sql`json_extract(data, '$.type') = 'step-finish'`)
              .run()
            yield* summary.summarize({ sessionID, messageID })
            const diff = yield* summary.diff({ sessionID, messageID })
            expect(diff).toHaveLength(1)
            expect(diff[0]).toMatchObject({ file: "file.txt", additions: 1, deletions: 1, status: "modified" })
            expect(diff[0]?.patch).toContain("-before")
            expect(diff[0]?.patch).toContain("+after")
            // Identical tree IDs must not keep a result computed under older ignore rules.
            yield* Effect.promise(() => Bun.write(`${directory}/.git/info/exclude`, "file.txt\n"))
            yield* summary.summarize({ sessionID, messageID })
            expect(yield* summary.diff({ sessionID, messageID })).toEqual([])
          }),
        { git: true },
      ).pipe(Effect.provide(f.realLayer))
    }),
  30000,
)

const withFixture = <A, E>(
  body: (
    f: Effect.Success<typeof fixture>,
  ) => Effect.Effect<A, E, SessionSummary.Service | Session.Service | Database.Service | Scope.Scope>,
  history = 0,
) =>
  Effect.gen(function* () {
    const f = yield* fixture
    return yield* Effect.gen(function* () {
      yield* seed(history)
      yield* f.listen
      return yield* body(f)
    }).pipe(inInstance, Effect.scoped, Effect.provide(f.layer))
  })

it.live("coalesces a burst, retains the latest finish and merges freshly edited user fields", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const summary = yield* SessionSummary.Service
      const database = yield* Database.Service
      f.control.blocked = true
      const first = yield* summary.summarize({ sessionID, messageID }).pipe(Effect.forkScoped)
      yield* f.entered.await
      yield* database.db
        .update(MessageTable)
        .set({
          data: sql`json_set(data, '$.summary.title', 'New title', '$.summary.body', 'New body')`,
        })
        .where(eq(MessageTable.id, messageID))
        .run()
      const burst = []
      for (let i = 0; i < 12; i++) {
        yield* finish(`latest-${i}`, i)
        burst.push(
          yield* summary.summarize({ sessionID, messageID }).pipe(Effect.forkScoped({ startImmediately: true })),
        )
      }
      yield* f.release.open
      yield* Fiber.join(first)
      yield* Effect.forEach(burst, Fiber.join)
      expect(f.pairs).toEqual([
        ["from", "initial"],
        ["from", "latest-11"],
      ])
      expect(f.metrics.messageWrites).toBe(1)
      const target = yield* database.db.select().from(MessageTable).where(eq(MessageTable.id, messageID)).get()
      expect(target?.data).toMatchObject({
        summary: { title: "New title", body: "New body", diffs: [{ patch: "from -> latest-11" }] },
      })
    }),
  ),
)

it.live("rechecks an identical pair for mid-computation requests and independent refreshes", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const summary = yield* SessionSummary.Service
      f.control.blocked = true
      const first = yield* summary.summarize({ sessionID, messageID }).pipe(Effect.forkScoped)
      yield* f.entered.await
      const second = yield* summary
        .summarize({ sessionID, messageID })
        .pipe(Effect.forkScoped({ startImmediately: true }))
      yield* f.release.open
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(f.metrics.diffCalls).toBe(2)
      expect(f.metrics.messageWrites).toBe(1)
      yield* summary.summarize({ sessionID, messageID })
      expect(f.metrics.diffCalls).toBe(3)
      expect(f.metrics.messageWrites).toBe(1)
    }),
  ),
)

it.live("publishes changed ignore-dependent output requested after observation but before diff return", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const summary = yield* SessionSummary.Service
      f.control.blocked = true
      const first = yield* summary.summarize({ sessionID, messageID }).pipe(Effect.forkScoped)
      // The boundary has observed the old ignore state, but has not returned its result.
      yield* f.entered.await
      f.control.ignored = true
      const second = yield* summary
        .summarize({ sessionID, messageID })
        .pipe(Effect.forkScoped({ startImmediately: true }))
      yield* f.release.open
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(yield* summary.diff({ sessionID, messageID })).toEqual([])
      expect(f.metrics.diffCalls).toBe(2)
      expect(f.metrics.messageWrites).toBe(1)
      expect(f.pairs).toEqual([
        ["from", "initial"],
        ["from", "initial"],
      ])
    }),
  ),
)

it.live("rechecks an identical pair when a new request arrives after diff computation", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const summary = yield* SessionSummary.Service
      const ready = yield* Latch.make()
      const release = yield* Latch.make()
      let reads = 0
      const first = yield* summary.summarize({ sessionID, messageID }).pipe(
        Effect.provideService(CurrentTransformer, (statement) =>
          Effect.gen(function* () {
            const query = statement.compile()[0]
            if (query.startsWith("select") && query.includes('from "message"') && !query.includes("join")) {
              reads++
              if (reads === 2) {
                yield* ready.open
                yield* release.await
              }
            }
            return statement
          }),
        ),
        Effect.forkScoped,
      )
      yield* ready.await
      const second = yield* summary
        .summarize({ sessionID, messageID })
        .pipe(Effect.forkScoped({ startImmediately: true }))
      yield* release.open
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(f.metrics.diffCalls).toBe(2)
      expect(f.metrics.messageWrites).toBe(1)
    }),
  ),
)

it.live("propagates a failed diff to waiters and permits a fresh retry", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const summary = yield* SessionSummary.Service
      f.control.blocked = true
      f.control.fail = true
      const first = yield* summary.summarize({ sessionID, messageID }).pipe(Effect.exit, Effect.forkScoped)
      yield* f.entered.await
      const second = yield* summary
        .summarize({ sessionID, messageID })
        .pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }))
      yield* finish("latest")
      yield* f.release.open
      expect(Exit.isFailure(yield* Fiber.join(first))).toBe(true)
      expect(Exit.isFailure(yield* Fiber.join(second))).toBe(true)
      expect(f.metrics.messageWrites).toBe(0)
      f.control.fail = false
      yield* summary.summarize({ sessionID, messageID })
      expect(f.pairs).toEqual([
        ["from", "initial"],
        ["from", "latest"],
      ])
      expect(f.metrics.messageWrites).toBe(1)
    }),
  ),
)

it.live("cancelling one caller does not cancel another caller's latest work", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const summary = yield* SessionSummary.Service
      f.control.blocked = true
      const first = yield* summary.summarize({ sessionID, messageID }).pipe(Effect.forkScoped)
      yield* f.entered.await
      yield* finish("latest")
      const second = yield* summary
        .summarize({ sessionID, messageID })
        .pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Fiber.interrupt(first)
      yield* f.release.open
      yield* Fiber.join(second)
      expect(f.pairs).toEqual([
        ["from", "initial"],
        ["from", "latest"],
      ])
      expect(f.metrics.messageWrites).toBe(1)
    }),
  ),
)

it.live("cancelling the last caller interrupts snapshot work without writing and allows retry", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const summary = yield* SessionSummary.Service
      f.control.blocked = true
      const first = yield* summary.summarize({ sessionID, messageID }).pipe(Effect.forkScoped)
      yield* f.entered.await
      yield* Fiber.interrupt(first)
      expect(f.metrics.messageWrites).toBe(0)
      yield* f.release.open
      yield* summary.summarize({ sessionID, messageID })
      expect(f.metrics.diffCalls).toBe(2)
      expect(f.metrics.messageWrites).toBe(1)
    }),
  ),
)

it.live("instance disposal interrupts an active refresh and clears its state", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const summary = yield* SessionSummary.Service
      f.control.blocked = true
      const first = yield* summary.summarize({ sessionID, messageID }).pipe(Effect.exit, Effect.forkScoped)
      yield* f.entered.await
      yield* Effect.promise(() => disposeInstance(instance.directory))
      const exit = yield* Fiber.join(first)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(f.metrics.messageWrites).toBe(0)
      yield* f.release.open
      yield* summary.summarize({ sessionID, messageID })
      expect(f.metrics.diffCalls).toBe(2)
    }),
  ),
)

it.live("instance disposal settles all waiters after asynchronous worker cleanup", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const summary = yield* SessionSummary.Service
      const cleaning = yield* Latch.make()
      const release = yield* Latch.make()
      f.control.blocked = true
      f.control.cleanup = cleaning.open.pipe(Effect.andThen(release.await))
      const callers = yield* Effect.forEach([0, 1], () =>
        summary.summarize({ sessionID, messageID }).pipe(Effect.exit, Effect.forkScoped({ startImmediately: true })),
      )
      yield* f.entered.await
      const disposal = yield* Effect.promise(() => disposeInstance(instance.directory)).pipe(Effect.forkScoped)
      // Scope.close now awaits the interrupted worker while its finalizer is suspended.
      yield* cleaning.await
      yield* release.open
      const exits = yield* awaitWithTimeout(
        Effect.forEach(callers, Fiber.join),
        "summary callers did not settle after worker cleanup",
      )
      expect(exits.every((exit) => Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))).toBe(true)
      yield* awaitWithTimeout(Fiber.join(disposal), "summary instance disposal did not settle after worker cleanup")
      expect(f.metrics.messageWrites).toBe(0)
    }),
  ),
)

it.live("does not coalesce active work across directories", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const summary = yield* SessionSummary.Service
      f.control.blocked = true
      const first = yield* summary.summarize({ sessionID, messageID }).pipe(Effect.forkScoped)
      yield* f.entered.await
      yield* f.entered.close
      const second = yield* summary
        .summarize({ sessionID, messageID })
        .pipe(
          Effect.provideService(InstanceRef, { ...instance, directory: `${instance.directory}/other` }),
          Effect.forkScoped,
        )
      yield* f.entered.await
      expect(f.metrics.diffCalls).toBe(2)
      yield* f.release.open
      yield* Fiber.join(first)
      yield* Fiber.join(second)
    }),
  ),
)

it.live("keeps different user turns independent while coalescing each turn's latest request", () =>
  withFixture(
    (f) =>
      Effect.gen(function* () {
        const summary = yield* SessionSummary.Service
        f.control.blocked = true
        const first = yield* summary.summarize({ sessionID, messageID }).pipe(Effect.forkScoped)
        yield* f.entered.await
        yield* f.entered.close
        const previous = MessageID.make("msg_000000_user")
        const other = yield* summary.summarize({ sessionID, messageID: previous }).pipe(Effect.forkScoped)
        yield* f.entered.await
        expect(f.metrics.diffCalls).toBe(2)
        yield* finish("latest")
        const latest = yield* summary
          .summarize({ sessionID, messageID })
          .pipe(Effect.forkScoped({ startImmediately: true }))
        yield* f.release.open
        yield* Effect.forEach([first, other, latest], Fiber.join)
        expect((yield* summary.diff({ sessionID, messageID }))[0]?.patch).toBe("from -> latest")
        expect((yield* summary.diff({ sessionID, messageID: previous }))[0]?.patch).toBe("from -> initial")
        expect(f.metrics.diffCalls).toBe(3)
        expect(f.metrics.messageWrites).toBe(2)
      }),
    1,
  ),
)

it.live("rechecks snapshot parts removed during a diff and clears the old turn diff", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const summary = yield* SessionSummary.Service
      const sessions = yield* Session.Service
      yield* summary.summarize({ sessionID, messageID })
      yield* f.entered.close
      f.control.blocked = true
      const pending = yield* summary.summarize({ sessionID, messageID }).pipe(Effect.forkScoped)
      yield* f.entered.await
      yield* sessions.removePart({ sessionID, messageID: assistantID, partID: PartID.make("prt_000000_9") })
      yield* f.release.open
      yield* Fiber.join(pending)
      expect(yield* summary.diff({ sessionID, messageID })).toEqual([])
    }),
  ),
)

it.live("does not resurrect a user message removed during a diff", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const summary = yield* SessionSummary.Service
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      f.control.blocked = true
      const pending = yield* summary.summarize({ sessionID, messageID }).pipe(Effect.forkScoped)
      yield* f.entered.await
      yield* sessions.removeMessage({ sessionID, messageID })
      yield* f.release.open
      yield* Fiber.join(pending)
      expect(yield* database.db.select().from(MessageTable).where(eq(MessageTable.id, messageID)).get()).toBeUndefined()
      expect(f.metrics.messageWrites).toBe(0)
    }),
  ),
)

it.live("handles disabled snapshots and missing/non-user targets without computing a diff", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      const summary = yield* SessionSummary.Service
      f.control.enabled = false
      yield* summary.summarize({ sessionID, messageID })
      f.control.enabled = true
      yield* summary.summarize({ sessionID, messageID: MessageID.make("msg_missing") })
      yield* summary.summarize({ sessionID, messageID: assistantID })
      expect(yield* summary.diff({ sessionID })).toEqual([])
      expect(yield* summary.diff({ sessionID, messageID: assistantID })).toEqual([])
      expect(f.metrics.diffCalls).toBe(0)
      expect(f.metrics.messageWrites).toBe(0)
      // Invalid targets must not clear the durable session summary.
      expect(f.metrics.diffEvents).toBe(1)
      expect(
        Exit.isFailure(yield* summary.diff({ sessionID: SessionID.make("ses_missing"), messageID }).pipe(Effect.exit)),
      ).toBe(true)
    }),
  ),
)

it.live("targeted snapshot selection matches full-history ordering including compaction assistants", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* Effect.gen(function* () {
      yield* seed(2)
      const database = yield* Database.Service
      const sessions = yield* Session.Service
      const summary = yield* SessionSummary.Service
      // A retained assistant from before the target user, and a newer unrelated turn.
      // The legacy selection is by parent identity, not a contiguous ID/time range.
      yield* database.db
        .update(MessageTable)
        .set({
          data: sql`json_set(data, '$.parentID', ${messageID}, '$.summary', true)`,
        })
        .where(eq(MessageTable.id, MessageID.make("msg_000000_assistant")))
        .run()
      yield* database.db
        .update(PartTable)
        .set({
          data: sql`json_set(data, '$.snapshot', 'retained-start')`,
        })
        .where(eq(PartTable.id, PartID.make("prt_000000_0")))
        .run()
      yield* database.db
        .update(MessageTable)
        .set({ time_created: 999 })
        .where(eq(MessageTable.id, MessageID.make("msg_000001_assistant")))
        .run()
      const messages = (yield* sessions.messages({ sessionID })).filter(
        (m) => m.info.id === messageID || (m.info.role === "assistant" && m.info.parentID === messageID),
      )
      const expected = yield* summary.computeDiff({ messages })
      yield* summary.summarize({ sessionID, messageID })
      expect(yield* summary.diff({ sessionID, messageID })).toEqual(expected)
      expect(f.pairs).toEqual([
        ["retained-start", "initial"],
        ["retained-start", "initial"],
      ])
    }).pipe(inInstance, Effect.scoped, Effect.provide(f.layer))
  }),
)

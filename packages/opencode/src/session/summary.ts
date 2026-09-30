import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema, Fiber, Scope } from "effect"
import { and, eq, or, sql } from "drizzle-orm"
import { isDeepStrictEqual } from "node:util"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { SessionID, MessageID } from "./schema"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"

function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return Buffer.from(bytes).toString()
}

export interface Interface {
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (input: { messages: SessionV1.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const database = yield* Database.Service
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        return {
          scope: yield* Scope.Scope,
          active: new Map<
            string,
            { work: { dirty: boolean; revision: number }; users: number; fiber: Fiber.Fiber<void> }
          >(),
        }
      }),
    )

    const message = Effect.fnUntraced(function* (input: { sessionID: SessionID; messageID: MessageID }) {
      const row = yield* database.db
        .select()
        .from(MessageTable)
        .where(and(eq(MessageTable.session_id, input.sessionID), eq(MessageTable.id, input.messageID)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return { ...row.data, id: row.id, sessionID: row.session_id } as SessionV1.Info
    })

    const snapshots = Effect.fnUntraced(function* (input: { sessionID: SessionID; messageID: MessageID }) {
      // Keep the same message/part ordering as Session.messages, without hydrating tool/text bodies.
      const parts = yield* database.db
        .select({
          type: sql<string>`json_extract(${PartTable.data}, '$.type')`,
          snapshot: sql<string>`json_extract(${PartTable.data}, '$.snapshot')`,
        })
        .from(MessageTable)
        .innerJoin(PartTable, eq(PartTable.message_id, MessageTable.id))
        .where(
          and(
            eq(MessageTable.session_id, input.sessionID),
            or(
              eq(MessageTable.id, input.messageID),
              and(
                sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
                sql`json_extract(${MessageTable.data}, '$.parentID') = ${input.messageID}`,
              ),
            ),
            sql`json_extract(${PartTable.data}, '$.type') in ('step-start', 'step-finish')`,
            sql`json_extract(${PartTable.data}, '$.snapshot') is not null`,
          ),
        )
        .orderBy(MessageTable.time_created, MessageTable.id, PartTable.id)
        .all()
        .pipe(Effect.orDie)
      return {
        from: parts.find((part) => part.type === "step-start" && part.snapshot)?.snapshot,
        to: parts.findLast((part) => part.type === "step-finish" && part.snapshot)?.snapshot,
      }
    })

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: { messages: SessionV1.WithParts[] }) {
      let from: string | undefined
      let to: string | undefined
      for (const item of input.messages) {
        if (!from) {
          for (const part of item.parts) {
            if (part.type === "step-start" && part.snapshot) {
              from = part.snapshot
              break
            }
          }
        }
        for (const part of item.parts) {
          if (part.type === "step-finish" && part.snapshot) to = part.snapshot
        }
      }
      if (from && to) return yield* snapshot.diffFull(from, to)
      return []
    })

    const refresh = Effect.fnUntraced(function* (
      input: {
        sessionID: SessionID
        messageID: MessageID
      },
      work: { dirty: boolean; revision: number },
    ) {
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: 0,
          deletions: 0,
          files: 0,
        },
      })
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: [] })
      if ((yield* config.get()).snapshot === false) return
      if ((yield* message(input))?.role !== "user") return
      // Only retain one pair for this active refresh. diffFull also consults current ignore rules,
      // so retaining results across independent calls would incorrectly hide ignore-file changes.
      let previous:
        | {
            from?: string
            to?: string
            revision: number
            diff: Effect.Effect<{ diffs: Snapshot.FileDiff[]; revision: number }>
          }
        | undefined
      do {
        work.dirty = false
        const pair = yield* snapshots(input)
        if (!previous || previous.from !== pair.from || previous.to !== pair.to || previous.revision < work.revision) {
          const revision = work.revision
          previous = {
            ...pair,
            revision,
            diff: yield* (pair.from && pair.to ? snapshot.diffFull(pair.from, pair.to) : Effect.succeed([])).pipe(
              // Ignore rules may be observed before diffFull returns. Only requests already
              // present at computation start are covered by this result.
              Effect.map((diffs) => ({ diffs, revision })),
              Effect.cached,
            ),
          }
        }
        const result = yield* previous.diff
        previous.revision = result.revision
        if (work.dirty) continue
        // A revert can remove parts while diffFull is waiting on the snapshot lock.
        const current = yield* snapshots(input)
        if (current.from !== pair.from || current.to !== pair.to) {
          work.dirty = true
          continue
        }
        // Reload before publishing: preserve concurrently edited summary/title fields and never
        // resurrect a user message removed by revert/compaction during snapshot work.
        const target = yield* message(input)
        if (!target || target.role !== "user") return
        if (work.dirty) continue
        if (!isDeepStrictEqual(target.summary?.diffs, result.diffs)) {
          yield* sessions.updateMessage({ ...target, summary: { ...target.summary, diffs: result.diffs } })
        }
      } while (work.dirty)
    })

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      const local = yield* InstanceState.get(state)
      const key = JSON.stringify([input.sessionID, input.messageID])
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const existing = local.active.get(key)
          const entry =
            existing ??
            (yield* Effect.gen(function* () {
              const work = { dirty: true, revision: 0 }
              const fiber = yield* refresh(input, work).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (local.active.get(key)?.work === work) local.active.delete(key)
                  }),
                ),
                Effect.forkIn(local.scope),
              )
              const entry = { work, users: 0, fiber }
              local.active.set(key, entry)
              return entry
            }))
          entry.work.dirty = true
          entry.work.revision++
          entry.users++
          // Await the Exit as a value before propagating interruption. Effect v4's
          // direct join can remove its observer during interrupted-worker notification,
          // skipping another waiter (including forkIn's scope-close finalizer).
          yield* restore(Fiber.await(entry.fiber)).pipe(
            Effect.flatMap((exit) => exit),
            Effect.ensuring(
              Effect.suspend(() => {
                entry.users--
                if (entry.users !== 0) return Effect.void
                if (local.active.get(key) === entry) local.active.delete(key)
                return Fiber.interrupt(entry.fiber)
              }),
            ),
          )
        }),
      )
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      if (!input.messageID) return []
      const target = yield* message({ sessionID: input.sessionID, messageID: input.messageID })
      if (!target) {
        yield* sessions.get(input.sessionID).pipe(Effect.orDie)
        return []
      }
      if (target.role !== "user") return []
      const diffs = target.summary?.diffs ?? []
      return diffs.map((item) => {
        if (item.file === undefined) return item
        const file = unquoteGitPath(item.file)
        if (file === item.file) return item
        return { ...item, file }
      })
    })

    return Service.of({ summarize, diff, computeDiff })
  }),
)

export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, Snapshot.node, EventV2Bridge.node, Config.node, Database.node],
})

export * as SessionSummary from "./summary"

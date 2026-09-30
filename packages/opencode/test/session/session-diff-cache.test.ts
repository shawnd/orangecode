import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { PartTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { SessionRevert } from "@/session/revert"
import { Snapshot } from "@/snapshot"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { disposeInstance } from "@/effect/instance-registry"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { fixture, seed, inInstance, instance, sessionID, assistantID } from "./summary-fixture"

const root = LayerNode.group([
  Session.node,
  SessionSummary.node,
  SessionRevert.node,
  Snapshot.node,
  SessionProjector.node,
  CrossSpawnSpawner.node,
])
const it = testEffect(Layer.empty)
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const step = Effect.fnUntraced(function* (id: SessionID, directory: string, content: string, file = "file.txt") {
  const sessions = yield* Session.Service
  const snapshot = yield* Snapshot.Service
  const parent = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: id,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: id,
    messageID: parent.id,
    type: "text",
    text: "edit file",
  })
  const assistant = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: id,
    role: "assistant",
    time: { created: Date.now() },
    parentID: parent.id,
    agent: "build",
    mode: "build",
    path: { cwd: directory, root: directory },
    providerID: ProviderV2.ID.make("test"),
    modelID: ModelV2.ID.make("test"),
    cost: 0,
    tokens,
  })
  const from = yield* snapshot.track()
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: id,
    messageID: assistant.id,
    type: "step-start",
    snapshot: from,
  })
  yield* Effect.promise(() => Bun.write(path.join(directory, file), content))
  const to = yield* snapshot.track()
  if (!from || !to) throw new Error("expected snapshots")
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: id,
    messageID: assistant.id,
    type: "step-finish",
    snapshot: to,
    reason: "stop",
    cost: 0,
    tokens,
  })
  const patch = yield* snapshot.patch(from)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: id,
    messageID: assistant.id,
    type: "patch",
    ...patch,
  })
  return parent
})

it.instance(
  "net counts exclude unrelated files and repeated edits, and track undo/redo",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const summary = yield* SessionSummary.Service
        const revert = yield* SessionRevert.Service
        const chat = yield* sessions.create({})
        yield* Effect.promise(() => Bun.write(path.join(test.directory, "file.txt"), "original\n"))
        const first = yield* step(chat.id, test.directory, "first\n")
        yield* Effect.promise(() => Bun.write(path.join(test.directory, "external.txt"), "unrelated\n"))
        yield* step(chat.id, test.directory, "second\n")
        yield* summary.sessionDiff(chat.id)
        expect((yield* sessions.get(chat.id)).summary).toMatchObject({ additions: 1, deletions: 1, files: 1 })

        const undone = yield* revert.revert({ sessionID: chat.id, messageID: first.id })
        expect(undone.summary).toMatchObject({ additions: 0, deletions: 0, files: 0 })
        yield* summary.sessionDiff(chat.id)
        expect((yield* sessions.get(chat.id)).summary?.additions).toBe(0)
        const restored = yield* revert.unrevert({ sessionID: chat.id })
        expect(restored.summary).toMatchObject({ additions: 1, deletions: 1, files: 1 })
        yield* revert.revert({ sessionID: chat.id, messageID: first.id })
        yield* revert.cleanup(yield* sessions.get(chat.id))
        expect((yield* sessions.get(chat.id)).summary?.additions).toBe(0)
      }).pipe(Effect.provide(LayerNode.compile(root)))
    }),
  { git: true, config: { formatter: false, lsp: false } },
)

it.instance(
  "reopens a SQLite cache and refreshes captures saved after the previous summary",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, ".gitignore"), "cache.db*\n"))
      const database = Database.layerFromPath(path.join(test.directory, "cache.db"))
      const layer = LayerNode.compile(root, [[Database.node, database]])
      const id = yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const summary = yield* SessionSummary.Service
        const chat = yield* sessions.create({})
        yield* step(chat.id, test.directory, "first\n")
        yield* summary.sessionDiff(chat.id)
        expect((yield* sessions.get(chat.id)).summary?.additions).toBe(1)
        // Simulate closing before the background summary catches up with the second turn.
        yield* step(chat.id, test.directory, "second\nextra\n")
        return chat.id
      }).pipe(Effect.provide(layer))
      yield* Effect.promise(() => disposeInstance(test.directory))
      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const summary = yield* SessionSummary.Service
        expect((yield* sessions.get(id)).summary?.additions).toBe(1)
        yield* summary.sessionDiff(id)
        expect((yield* sessions.get(id)).summary).toMatchObject({ additions: 2, deletions: 0, files: 1 })
        expect((yield* sessions.get(id)).summary?.diffs?.[0]?.patch).toBeUndefined()
      }).pipe(Effect.provide(layer))
    }),
  { git: true, config: { formatter: false, lsp: false } },
)

it.instance(
  "counts literal filenames with quotes, tabs, newlines and surrounding spaces",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const summary = yield* SessionSummary.Service
        const chat = yield* sessions.create({})
        const name = ' :literal\t"quoted"\n.txt '
        yield* step(chat.id, test.directory, "one\n", name)
        yield* summary.sessionDiff(chat.id)
        expect((yield* sessions.get(chat.id)).summary).toMatchObject({
          additions: 1,
          deletions: 0,
          files: 1,
          diffs: [{ file: name, additions: 1, deletions: 0, status: "added" }],
        })
      }).pipe(Effect.provide(LayerNode.compile(root)))
    }),
  { git: true, config: { formatter: false, lsp: false } },
)

it.live("cache hits avoid Git work and a concurrent newer capture cannot be overwritten", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* Effect.gen(function* () {
      yield* seed()
      const sessions = yield* Session.Service
      const summary = yield* SessionSummary.Service
      const database = yield* Database.Service
      yield* sessions.updatePart({
        id: PartID.make("prt_000000_z"),
        sessionID,
        messageID: assistantID,
        type: "patch",
        hash: "from",
        files: [path.join(instance.worktree, "file.txt")],
      })
      yield* summary.sessionDiff(sessionID)
      yield* summary.sessionDiff(sessionID)
      expect(f.metrics.diffCalls).toBe(1)
      yield* Effect.promise(() => disposeInstance(instance.directory))
      yield* summary.sessionDiff(sessionID)
      expect(f.metrics.diffCalls).toBe(1)
      yield* f.entered.close
      f.control.blocked = true
      const older = yield* summary.sessionDiff(sessionID, true).pipe(Effect.forkScoped)
      yield* f.entered.await
      yield* database.db
        .update(PartTable)
        .set({ data: sql`json_set(data, '$.snapshot', 'latest')` })
        .where(eq(PartTable.id, PartID.make("prt_000000_9")))
        .run()
      const newer = yield* summary.sessionDiff(sessionID).pipe(Effect.forkScoped)
      yield* f.release.open
      yield* Fiber.join(newer)
      yield* Fiber.join(older)
      const cached = yield* sessions.get(sessionID)
      expect(cached.metadata?.["opencode.sessionDiff"]).toContain("latest")
      expect(cached.metadata?.["opencode.sessionDiff"]).not.toContain("initial")
      const calls = f.metrics.diffCalls
      yield* summary.sessionDiff(sessionID)
      expect(f.metrics.diffCalls).toBe(calls)
      yield* sessions.setRevert({
        sessionID,
        revert: { messageID: assistantID, partID: PartID.make("prt_000000_z") },
        summary: cached.summary,
      })
      yield* summary.sessionDiff(sessionID)
      expect((yield* sessions.get(sessionID)).summary?.additions).toBe(0)
      yield* sessions.clearRevert(sessionID)
      yield* summary.sessionDiff(sessionID)
      expect((yield* sessions.get(sessionID)).summary?.additions).toBe(1)
    }).pipe(inInstance, Effect.scoped, Effect.provide(f.layer))
  }),
)

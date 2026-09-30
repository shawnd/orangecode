import { Effect, Layer, Latch } from "effect"
import { CurrentTransformer } from "effect/unstable/sql/Statement"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionSummary } from "@/session/summary"
import { Session } from "@/session/session"
import { Snapshot } from "@/snapshot"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { sql } from "drizzle-orm"

export const sessionID = SessionID.make("ses_summary_probe")
export const messageID = MessageID.make("msg_999999_user")
export const assistantID = MessageID.make("msg_999999_assistant")
export const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
export const instance = {
  directory: "/tmp/opencode/summary-fixture",
  worktree: "/tmp/opencode/summary-fixture",
  project: {
    id: ProjectV2.ID.make("summary_fixture"),
    worktree: "/tmp/opencode/summary-fixture",
    time: { created: 1, updated: 1 },
    sandboxes: [],
  },
}

export const fixture = Effect.gen(function* () {
  const entered = yield* Latch.make()
  const release = yield* Latch.make()
  const metrics = { queries: 0, reads: 0, writes: 0, messageWrites: 0, diffEvents: 0, diffCalls: 0 }
  const pairs: string[][] = []
  const control = { blocked: false, fail: false, enabled: true, ignored: false, cleanup: Effect.void }
  const compare = Effect.fnUntraced(
    function* (from: string, to: string) {
      metrics.diffCalls++
      pairs.push([from, to])
      const ignored = control.ignored
      yield* entered.open
      if (control.blocked) yield* release.await
      if (control.fail) return yield* Effect.die("snapshot failure")
      if (ignored) return []
      return [{ file: "file.txt", patch: `${from} -> ${to}`, additions: 1, deletions: 0, status: "modified" as const }]
    },
    Effect.ensuring(Effect.suspend(() => control.cleanup)),
  )
  const snapshot = Layer.mock(Snapshot.Service, {
    diffFull: compare,
    stats: compare,
  })
  const config = Layer.mock(Config.Service, { get: () => Effect.sync(() => ({ snapshot: control.enabled })) })
  const root = LayerNode.group([
    SessionSummary.node,
    Session.node,
    Snapshot.node,
    SessionProjector.node,
    Database.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
  ])
  const database = Database.layerFromPath(":memory:")
  const layer = LayerNode.compile(root, [
    [Database.node, database],
    [Snapshot.node, snapshot],
    [Config.node, config],
  ])
  const realLayer = LayerNode.compile(root, [
    [Database.node, database],
    [Config.node, config],
  ])
  const measure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(CurrentTransformer, (statement) =>
        Effect.sync(() => {
          const query = statement.compile()[0].toLowerCase()
          metrics.queries++
          if (query.startsWith("select")) metrics.reads++
          if (/^(insert|update|delete)/.test(query)) metrics.writes++
          return statement
        }),
      ),
    )
  const listen = Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const off = yield* events.listen((event) =>
      Effect.sync(() => {
        if (event.type === SessionV1.Event.MessageUpdated.type) metrics.messageWrites++
        if (event.type === Session.Event.Diff.type) metrics.diffEvents++
      }),
    )
    yield* Effect.addFinalizer(() => off)
  })
  return { layer, realLayer, metrics, pairs, control, entered, release, measure, listen }
})

export const seed = Effect.fnUntraced(function* (history = 0) {
  const database = yield* Database.Service
  yield* database.db
    .insert(ProjectTable)
    .values({
      id: instance.project.id,
      worktree: AbsolutePath.make(instance.worktree),
      sandboxes: [],
    })
    .run()
  yield* database.db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: instance.project.id,
      slug: "summary",
      directory: instance.directory,
      title: "summary",
      version: "test",
      time_created: 1,
      time_updated: 1,
    })
    .run()
  for (let i = 0; i <= history; i++) {
    const user = i === history ? messageID : MessageID.make(`msg_${String(i).padStart(6, "0")}_user`)
    const assistant = i === history ? assistantID : MessageID.make(`msg_${String(i).padStart(6, "0")}_assistant`)
    yield* database.db
      .insert(MessageTable)
      .values([
        {
          id: user,
          session_id: sessionID,
          time_created: i * 2,
          // Include a legacy summary containing only retained title/body fields.
          data: sql`${JSON.stringify({
            role: "user",
            time: { created: i * 2 },
            agent: "build",
            model: { providerID: "test", modelID: "test" },
            summary: { title: "Retained title", body: "Retained body" },
          })}`,
        },
        {
          id: assistant,
          session_id: sessionID,
          time_created: i * 2 + 1,
          data: sql`${JSON.stringify({
            role: "assistant",
            parentID: user,
            time: { created: i * 2 + 1 },
            agent: "build",
            mode: "build",
            providerID: "test",
            modelID: "test",
            path: { cwd: instance.directory, root: instance.worktree },
            cost: 0,
            tokens,
          })}`,
        },
      ])
      .run()
    yield* database.db
      .insert(PartTable)
      .values(
        Array.from({ length: 10 }, (_, j) => ({
          id: PartID.make(`prt_${String(i).padStart(6, "0")}_${j}`),
          message_id: assistant,
          session_id: sessionID,
          data:
            j === 0
              ? { type: "step-start" as const, snapshot: "from" }
              : j === 9
                ? { type: "step-finish" as const, snapshot: "initial", reason: "tool-calls", cost: 0, tokens }
                : { type: "text" as const, text: "x".repeat(2048) },
        })),
      )
      .run()
  }
})

export const finish = Effect.fnUntraced(function* (snapshot: string, index = 10) {
  const sessions = yield* Session.Service
  yield* sessions.updatePart({
    id: PartID.make(`prt_latest_${String(index).padStart(6, "0")}`),
    sessionID,
    messageID: assistantID,
    type: "step-finish",
    snapshot,
    reason: "tool-calls",
    cost: 0,
    tokens,
  })
})

export const inInstance = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(InstanceRef, instance))

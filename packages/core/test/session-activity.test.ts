import path from "path"
import { expect } from "bun:test"
import { Context, Effect, FileSystem, Layer, Schedule, Schema, Scope } from "effect"
import { LayerNode } from "../src/effect/layer-node"
import { filesystem } from "../src/effect/app-node-platform"
import { Global } from "../src/global"
import { SessionActivity } from "../src/session/activity"
import { SessionSchema } from "../src/session/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([filesystem, Global.node])))
const directory = Effect.acquireRelease(Effect.promise(tmpdir), (dir) =>
  Effect.promise(() => dir[Symbol.asyncDispose]()),
).pipe(Effect.map((dir) => dir.path))

it.live("discovers active work from a separate process and ignores stale or malformed snapshots", () =>
  Effect.gen(function* () {
    const dir = yield* directory
    const fs = yield* FileSystem.FileSystem
    const sessionID = SessionSchema.ID.make("ses_other_process")
    const activity = Context.get(
      yield* Layer.build(SessionActivity.layer.pipe(Layer.provide(Global.layerWith({ state: dir })))),
      SessionActivity.Service,
    )
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.spawn([process.execPath, path.join(import.meta.dirname, "fixture/activity-process.ts"), dir, sessionID], {
          stdout: "pipe",
          stderr: "pipe",
        }),
      ),
      (child) =>
        Effect.promise(async () => {
          child.kill()
          await child.exited
        }),
    )
    const reader = child.stdout.getReader()
    const ready = yield* Effect.promise(() => reader.read()).pipe(Effect.timeout("10 seconds"))
    expect(new TextDecoder().decode(ready.value)).toContain("ready")
    reader.releaseLock()
    expect(yield* activity.list()).toEqual([
      expect.objectContaining({ sessionID, status: { type: "busy" }, pid: child.pid }),
    ])

    const files = yield* fs.readDirectory(path.join(dir, "session-activity"))
    const file = files.find((file) => file.endsWith(".json"))
    expect(file).toBeDefined()
    if (!file) return
    const snapshot = JSON.parse(yield* fs.readFileString(path.join(dir, "session-activity", file)))
    yield* fs.writeFileString(
      path.join(dir, "session-activity/stale.json"),
      JSON.stringify({ ...snapshot, heartbeat: Date.now() - SessionActivity.staleAfter - 1 }),
    )
    yield* fs.writeFileString(path.join(dir, "session-activity/broken.json"), "{")
    yield* fs.writeFileString(path.join(dir, "session-activity/incomplete.json.tmp"), "{")
    expect(yield* activity.list()).toHaveLength(1)
  }),
)

it.live("publishes status transitions, preserves start time, and removes presence on scope disposal", () =>
  Effect.gen(function* () {
    const dir = yield* directory
    const scope = yield* Scope.make()
    const activity = Context.get(
      yield* Layer.buildWithScope(SessionActivity.layer.pipe(Layer.provide(Global.layerWith({ state: dir }))), scope),
      SessionActivity.Service,
    )
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit))
    const sessionID = SessionSchema.ID.make("ses_status_transitions")
    yield* activity.set(sessionID, { type: "busy" }, dir)
    const before = yield* activity.list()
    expect(before).toHaveLength(1)
    yield* activity.set(sessionID, { type: "retry", attempt: 1, message: "Rate limited", next: Date.now() + 1_000 })
    const retry = yield* activity.list()
    expect(retry[0].started).toBe(before[0].started)
    expect(retry[0].status.type).toBe("retry")
    expect(retry[0].directory).toBe(dir)
    yield* activity.set(sessionID, { type: "idle" })
    expect(yield* activity.list()).toEqual([])
    yield* activity.set(sessionID, { type: "busy" })
    yield* Scope.close(scope, yield* Effect.exit(Effect.void))
    expect(yield* activity.list()).toEqual([])
  }),
)

it.live("refreshes heartbeats without requiring another status transition", () =>
  Effect.gen(function* () {
    const dir = yield* directory
    const activity = Context.get(
      yield* Layer.build(SessionActivity.layer.pipe(Layer.provide(Global.layerWith({ state: dir })))),
      SessionActivity.Service,
    )
    const sessionID = SessionSchema.ID.make("ses_long_running")
    yield* activity.set(sessionID, { type: "busy" })
    const fs = yield* FileSystem.FileSystem
    const files = yield* fs.readDirectory(path.join(dir, "session-activity"))
    const file = files.find((file) => file.endsWith(".json"))
    expect(file).toBeDefined()
    if (!file) return
    const heartbeat = fs.readFileString(path.join(dir, "session-activity", file)).pipe(
      Effect.map(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ heartbeat: Schema.Number })))),
      Effect.map((snapshot) => snapshot.heartbeat),
    )
    const before = yield* heartbeat
    yield* heartbeat.pipe(
      Effect.repeat({ until: (value) => value >= before + 4_000, schedule: Schedule.spaced("100 millis") }),
      Effect.timeout("10 seconds"),
    )
    expect(yield* activity.list()).toEqual([expect.objectContaining({ sessionID })])
  }),
  15_000,
)

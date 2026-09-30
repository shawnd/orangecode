import { expect } from "bun:test"
import { Deferred, Effect, Fiber, RcMap } from "effect"
import { eq } from "drizzle-orm"
import { AgentV2 } from "../src/agent"
import { BackgroundJob } from "../src/background-job"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { LocationServiceMap } from "../src/location-service-map"
import { PermissionV2 } from "../src/permission"
import { QuestionV2 } from "../src/question"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionProjector } from "../src/session/projector"
import { SessionTable } from "../src/session/sql"
import { SessionWork } from "../src/session/work"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionV2.node,
      SessionProjector.node,
      SessionWork.node,
      BackgroundJob.node,
      LocationServiceMap.node,
      Database.node,
    ]),
    [[SessionExecution.node, SessionExecution.noopLayer]],
  ),
)

it.live("observes background jobs and child questions without booting idle Locations", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(Effect.promise(tmpdir), (dir) =>
      Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    const sessions = yield* SessionV2.Service
    const jobs = yield* BackgroundJob.Service
    const locations = yield* LocationServiceMap.Service
    const work = yield* SessionWork.Service
    const database = yield* Database.Service
    const root = yield* sessions.create({ location: { directory: AbsolutePath.make(directory.path) } })
    const child = yield* sessions.create({ location: root.location })
    // Current creation has no parent option; represent an existing projected child.
    yield* database.db
      .update(SessionTable)
      .set({ parent_id: root.id })
      .where(eq(SessionTable.id, child.id))
      .run()
      .pipe(Effect.orDie)
    expect(yield* work.get(root.id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
    expect([...(yield* RcMap.keys(locations.rcMap))]).toEqual([])

    const agent = yield* jobs.start({ type: "task", metadata: { sessionId: child.id }, run: Effect.never })
    const shell = yield* jobs.start({ type: "shell", metadata: { sessionId: child.id }, run: Effect.never })
    expect(yield* work.get(root.id)).toEqual({ type: "working", foreground: "idle", agents: 1, shells: 1 })
    const ready = yield* Deferred.make<QuestionV2.Request>()
    const question = yield* Effect.gen(function* () {
      const questions = yield* QuestionV2.Service
      const asked = yield* questions
        .ask({ sessionID: child.id, questions: [] })
        .pipe(Effect.forkChild({ startImmediately: true }))
      const requests = yield* questions.list()
      const request = requests.find((request) => request.sessionID === child.id)
      if (!request) return yield* Effect.die("Question was not admitted")
      yield* Deferred.succeed(ready, request)
      return yield* Fiber.join(asked)
    }).pipe(Effect.provide(locations.get(root.location)), Effect.forkChild)
    const request = yield* Deferred.await(ready).pipe(Effect.timeout("10 seconds"))
    expect(yield* work.get(root.id)).toEqual({ type: "blocked", foreground: "idle", agents: 1, shells: 1 })
    yield* QuestionV2.Service.use((questions) => questions.reply({ requestID: request.id, answers: [] })).pipe(
      Effect.provide(locations.get(root.location)),
    )
    yield* Fiber.join(question)
    yield* jobs.cancel(agent.id)
    yield* jobs.cancel(shell.id)
    expect(yield* work.get(root.id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
  }),
)

it.live("limits child activity to its subtree, excluding ancestor and sibling jobs and questions", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(Effect.promise(tmpdir), (dir) =>
      Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    const sessions = yield* SessionV2.Service
    const jobs = yield* BackgroundJob.Service
    const work = yield* SessionWork.Service
    const root = yield* sessions.create({ location: { directory: AbsolutePath.make(directory.path) } })
    const child = yield* sessions.create({ location: root.location })
    const sibling = yield* sessions.create({ location: root.location })
    const grandchild = yield* sessions.create({ location: root.location })
    yield* parent(root.id, child.id)
    yield* parent(root.id, sibling.id)
    yield* parent(child.id, grandchild.id)
    yield* jobs.start({ type: "shell", metadata: { sessionId: root.id }, run: Effect.never })
    yield* jobs.start({ type: "task", metadata: { sessionId: sibling.id }, run: Effect.never })
    yield* jobs.start({ type: "shell", metadata: { sessionId: sibling.id }, run: Effect.never })
    const ancestorQuestion = yield* pendingQuestion(root)
    const siblingQuestion = yield* pendingQuestion(sibling)

    expect(yield* work.get(child.id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
    expect(yield* work.get(root.id)).toEqual({ type: "blocked", foreground: "idle", agents: 1, shells: 2 })
    yield* jobs.start({ type: "task", metadata: { sessionId: grandchild.id }, run: Effect.never })
    yield* jobs.start({ type: "shell", metadata: { sessionId: grandchild.id }, run: Effect.never })
    expect(yield* work.get(child.id)).toEqual({ type: "working", foreground: "idle", agents: 1, shells: 1 })
    expect(yield* work.get(root.id)).toEqual({ type: "blocked", foreground: "idle", agents: 2, shells: 3 })

    const descendantQuestion = yield* pendingQuestion(grandchild)
    expect(yield* work.get(child.id)).toEqual({ type: "blocked", foreground: "idle", agents: 1, shells: 1 })
    yield* Fiber.interrupt(descendantQuestion.fiber)
    expect(yield* work.get(child.id)).toEqual({ type: "working", foreground: "idle", agents: 1, shells: 1 })
    yield* Fiber.interrupt(ancestorQuestion.fiber)
    yield* Fiber.interrupt(siblingQuestion.fiber)
    expect(yield* work.get(root.id)).toEqual({ type: "working", foreground: "idle", agents: 2, shells: 3 })
  }),
)

it.live("aggregates pending permissions and questions across family Locations with isolated replies", () =>
  Effect.gen(function* () {
    const directories = yield* Effect.forEach([0, 1, 2], () =>
      Effect.acquireRelease(Effect.promise(tmpdir), (dir) => Effect.promise(() => dir[Symbol.asyncDispose]())),
    )
    const sessions = yield* SessionV2.Service
    const locations = yield* LocationServiceMap.Service
    const work = yield* SessionWork.Service
    const root = yield* sessions.create({ location: { directory: AbsolutePath.make(directories[0].path) } })
    const child = yield* sessions.create({ location: { directory: AbsolutePath.make(directories[1].path) } })
    const unrelated = yield* sessions.create({ location: { directory: AbsolutePath.make(directories[2].path) } })
    const sameLocation = yield* sessions.create({ location: root.location })
    yield* parent(root.id, child.id)
    const question = yield* pendingQuestion(child)
    const permission = yield* pendingPermission(root)
    const otherPermission = yield* pendingPermission(unrelated)
    const otherQuestion = yield* pendingQuestion(sameLocation)

    expect(yield* work.get(root.id)).toEqual({ type: "blocked", foreground: "idle", agents: 0, shells: 0 })
    expect(yield* work.get(child.id)).toEqual({ type: "blocked", foreground: "idle", agents: 0, shells: 0 })
    const wrongQuestion = yield* QuestionV2.Service.use((questions) =>
      questions.reply({ requestID: question.request.id, answers: [] }),
    ).pipe(Effect.provide(locations.get(root.location)), Effect.flip)
    expect(wrongQuestion).toBeInstanceOf(QuestionV2.NotFoundError)
    const wrongPermission = yield* PermissionV2.Service.use((permissions) =>
      permissions.reply({ requestID: permission.id, reply: "once" }),
    ).pipe(Effect.provide(locations.get(child.location)), Effect.flip)
    expect(wrongPermission).toBeInstanceOf(PermissionV2.NotFoundError)

    yield* QuestionV2.Service.use((questions) => questions.reply({ requestID: question.request.id, answers: [] })).pipe(
      Effect.provide(locations.get(child.location)),
    )
    yield* Fiber.join(question.fiber)
    expect(yield* work.get(child.id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
    expect(yield* work.get(root.id)).toEqual({ type: "blocked", foreground: "idle", agents: 0, shells: 0 })
    const childPermission = yield* pendingPermission(child)
    yield* PermissionV2.Service.use((permissions) =>
      permissions.reply({ requestID: permission.id, reply: "once" }),
    ).pipe(Effect.provide(locations.get(root.location)))
    expect(yield* work.get(root.id)).toEqual({ type: "blocked", foreground: "idle", agents: 0, shells: 0 })
    expect(yield* work.get(child.id)).toEqual({ type: "blocked", foreground: "idle", agents: 0, shells: 0 })
    yield* PermissionV2.Service.use((permissions) =>
      permissions.reply({ requestID: childPermission.id, reply: "once" }),
    ).pipe(Effect.provide(locations.get(child.location)))
    expect(yield* work.get(root.id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
    expect(yield* work.get(unrelated.id)).toEqual({ type: "blocked", foreground: "idle", agents: 0, shells: 0 })
    expect(yield* work.get(sameLocation.id)).toEqual({ type: "blocked", foreground: "idle", agents: 0, shells: 0 })
    yield* Fiber.interrupt(otherQuestion.fiber)
    yield* PermissionV2.Service.use((permissions) =>
      permissions.reply({ requestID: otherPermission.id, reply: "once" }),
    ).pipe(Effect.provide(locations.get(unrelated.location)))
  }),
)

it.live("observes historical cross-Location descendants without materializing their Locations", () =>
  Effect.gen(function* () {
    const directories = yield* Effect.forEach([0, 1, 2, 3], () =>
      Effect.acquireRelease(Effect.promise(tmpdir), (dir) => Effect.promise(() => dir[Symbol.asyncDispose]())),
    )
    const sessions = yield* SessionV2.Service
    const locations = yield* LocationServiceMap.Service
    const jobs = yield* BackgroundJob.Service
    const work = yield* SessionWork.Service
    const family = yield* Effect.forEach(directories.slice(0, 3), (directory) =>
      sessions.create({ location: { directory: AbsolutePath.make(directory.path) } }),
    )
    yield* parent(family[0].id, family[1].id)
    yield* parent(family[1].id, family[2].id)
    expect([...(yield* RcMap.keys(locations.rcMap))]).toEqual([])
    expect(yield* work.get(family[0].id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
    expect([...(yield* RcMap.keys(locations.rcMap))]).toEqual([])

    const unrelated = yield* sessions.create({ location: { directory: AbsolutePath.make(directories[3].path) } })
    // A request for a family ID in an unrelated Location must not leak into the aggregate.
    const misplaced = yield* pendingQuestion({ ...family[0], location: unrelated.location })
    const live = [...(yield* RcMap.keys(locations.rcMap))]
    expect(live.map((ref) => ref.directory)).toEqual([unrelated.location.directory])
    expect(yield* work.get(family[0].id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
    const shell = yield* jobs.start({ type: "shell", metadata: { sessionId: family[2].id }, run: Effect.never })
    expect(yield* work.get(family[0].id)).toEqual({ type: "working", foreground: "idle", agents: 0, shells: 1 })
    expect(yield* work.get(family[1].id)).toEqual({ type: "working", foreground: "idle", agents: 0, shells: 1 })
    expect([...(yield* RcMap.keys(locations.rcMap))]).toEqual(live)
    yield* jobs.cancel(shell.id)
    yield* Fiber.interrupt(misplaced.fiber)
    expect(yield* work.get(family[0].id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
    expect([...(yield* RcMap.keys(locations.rcMap))]).toEqual(live)

    const descendantQuestion = yield* pendingQuestion(family[2])
    const mixed = [...(yield* RcMap.keys(locations.rcMap))]
    expect(mixed.map((ref) => ref.directory).toSorted()).toEqual(
      [unrelated.location.directory, family[2].location.directory].toSorted(),
    )
    expect(yield* work.get(family[0].id)).toEqual({ type: "blocked", foreground: "idle", agents: 0, shells: 0 })
    expect([...(yield* RcMap.keys(locations.rcMap))]).toEqual(mixed)
    yield* Fiber.interrupt(descendantQuestion.fiber)
    expect(yield* work.get(family[0].id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
    expect([...(yield* RcMap.keys(locations.rcMap))]).toEqual(mixed)
  }),
)

it.live("counts distinct descendant agents and individual shells, ignoring terminal and unowned jobs", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(Effect.promise(tmpdir), (dir) =>
      Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    const sessions = yield* SessionV2.Service
    const jobs = yield* BackgroundJob.Service
    const work = yield* SessionWork.Service
    const root = yield* sessions.create({ location: { directory: AbsolutePath.make(directory.path) } })
    const child = yield* sessions.create({ location: root.location })
    yield* parent(root.id, child.id)
    const tasks = yield* Effect.forEach([0, 1], () =>
      jobs.start({ type: "task", metadata: { sessionId: child.id }, run: Effect.never }),
    )
    yield* jobs.start({ type: "task", metadata: { sessionId: root.id }, run: Effect.never })
    yield* Effect.forEach(
      [undefined, {}, { sessionId: 42 }, { sessionID: child.id }, { sessionId: "ses_unrelated" }],
      (metadata) => jobs.start({ type: "shell", metadata, run: Effect.never }),
    )
    yield* jobs.start({ type: "other", metadata: { sessionId: child.id }, run: Effect.never })
    const shells = yield* Effect.forEach([root.id, child.id, child.id], (sessionId) =>
      jobs.start({ type: "shell", metadata: { sessionId }, run: Effect.never }),
    )
    expect(yield* work.get(root.id)).toEqual({ type: "working", foreground: "idle", agents: 1, shells: 3 })
    expect(yield* work.get(child.id)).toEqual({ type: "working", foreground: "idle", agents: 0, shells: 2 })
    yield* jobs.cancel(tasks[0].id)
    expect(yield* work.get(root.id)).toEqual({ type: "working", foreground: "idle", agents: 1, shells: 3 })
    yield* jobs.cancel(tasks[1].id)
    yield* Effect.forEach(shells, (shell) => jobs.cancel(shell.id))

    const completed = yield* jobs.start({
      type: "task",
      metadata: { sessionId: child.id },
      run: Effect.succeed("done"),
    })
    const failed = yield* jobs.start({ type: "shell", metadata: { sessionId: child.id }, run: Effect.fail("failed") })
    expect((yield* jobs.wait({ id: completed.id })).info?.status).toBe("completed")
    expect((yield* jobs.wait({ id: failed.id })).info?.status).toBe("error")
    expect((yield* jobs.list()).filter((job) => job.status === "cancelled")).toHaveLength(5)
    expect(yield* work.get(root.id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
    expect(yield* work.get(child.id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
  }),
)

it.live("returns a typed not-found error without booting Locations for an absent Session", () =>
  Effect.gen(function* () {
    const work = yield* SessionWork.Service
    const locations = yield* LocationServiceMap.Service
    const sessionID = SessionV2.ID.make("ses_missing_activity")
    const error = yield* work.get(sessionID).pipe(Effect.flip)
    expect(error).toBeInstanceOf(SessionV2.NotFoundError)
    expect(error).toMatchObject({ sessionID })
    expect([...(yield* RcMap.keys(locations.rcMap))]).toEqual([])
  }),
)

const parent = Effect.fn("test.projectParent")(function* (parentID: SessionV2.ID, childID: SessionV2.ID) {
  const database = yield* Database.Service
  // Session creation has no parent option; attach the projected row as historical data.
  yield* database.db
    .update(SessionTable)
    .set({ parent_id: parentID })
    .where(eq(SessionTable.id, childID))
    .run()
    .pipe(Effect.orDie)
})

const pendingQuestion = Effect.fn("test.pendingQuestion")(function* (session: SessionV2.Info) {
  const locations = yield* LocationServiceMap.Service
  const ready = yield* Deferred.make<QuestionV2.Request>()
  const fiber = yield* Effect.gen(function* () {
    const questions = yield* QuestionV2.Service
    const asked = yield* questions
      .ask({ sessionID: session.id, questions: [] })
      .pipe(Effect.forkChild({ startImmediately: true }))
    const request = (yield* questions.list()).find((request) => request.sessionID === session.id)
    if (!request) return yield* Effect.die("Question was not admitted")
    yield* Deferred.succeed(ready, request)
    return yield* Fiber.join(asked)
  }).pipe(Effect.provide(locations.get(session.location)), Effect.forkChild)
  return { fiber, request: yield* Deferred.await(ready).pipe(Effect.timeout("10 seconds")) }
})

const pendingPermission = Effect.fn("test.pendingPermission")(function* (session: SessionV2.Info) {
  const locations = yield* LocationServiceMap.Service
  return yield* Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const permissions = yield* PermissionV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.defaultID, (agent) => {
        agent.permissions = [{ action: "*", resource: "*", effect: "ask" }]
      }),
    )
    const request = yield* permissions.ask({ sessionID: session.id, action: "read", resources: ["test.ts"] })
    expect(request.effect).toBe("ask")
    return request
  }).pipe(Effect.provide(locations.get(session.location)))
})

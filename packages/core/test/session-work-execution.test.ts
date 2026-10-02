import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { eq } from "drizzle-orm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { Auth } from "@opencode-ai/llm/route"
import { Database } from "../src/database/database"
import { BackgroundJob } from "../src/background-job"
import { makeGlobalNode, makeLocationNode } from "../src/effect/app-node"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { LocationServiceMap } from "../src/location-service-map"
import { QuestionV2 } from "../src/question"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionExecutionLocal } from "../src/session/execution/local"
import { SessionProjector } from "../src/session/projector"
import { SessionRunnerModel } from "../src/session/runner/model"
import { SessionTable } from "../src/session/sql"
import { SessionWork } from "../src/session/work"
import { TestLLMServer } from "../../opencode/test/lib/llm-server"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const llm = makeGlobalNode({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })
const model = makeLocationNode({
  service: SessionRunnerModel.Service,
  layer: Layer.effect(
    SessionRunnerModel.Service,
    Effect.gen(function* () {
      const server = yield* TestLLMServer
      return SessionRunnerModel.Service.of({
        resolve: () =>
          Effect.succeed(
            OpenAIChat.route
              .with({
                endpoint: { baseURL: server.url },
                auth: Auth.none,
                limits: { context: 100_000, output: 1000 },
              })
              .model({ id: "test-model" }),
          ),
      })
    }),
  ),
  deps: [llm],
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionV2.node,
      SessionProjector.node,
      SessionWork.node,
      SessionExecution.node,
      Database.node,
      BackgroundJob.node,
      LocationServiceMap.node,
      llm,
    ]),
    [
      [SessionExecution.node, SessionExecutionLocal.node],
      [SessionRunnerModel.node, model],
    ],
  ),
)

it.live("observes actual foreground and descendant drains through streaming model completion and interruption", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(Effect.promise(tmpdir), (dir) =>
      Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    const sessions = yield* SessionV2.Service
    const server = yield* TestLLMServer
    const work = yield* SessionWork.Service
    const database = yield* Database.Service
    const jobs = yield* BackgroundJob.Service
    const locations = yield* LocationServiceMap.Service
    const root = yield* sessions.create({ location: { directory: AbsolutePath.make(directory.path) } })
    const child = yield* sessions.create({ location: root.location })
    yield* database.db
      .update(SessionTable)
      .set({ parent_id: root.id })
      .where(eq(SessionTable.id, child.id))
      .run()
      .pipe(Effect.orDie)
    const releaseRoot = Promise.withResolvers<void>()
    const releaseChild = Promise.withResolvers<void>()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        releaseRoot.resolve()
        releaseChild.resolve()
      }),
    )
    yield* server.hold("root finished", releaseRoot.promise)
    yield* server.hold("child finished", releaseChild.promise)
    yield* sessions.prompt({ sessionID: root.id, prompt: { text: "root work" }, resume: false })
    const foreground = yield* sessions.resume(root.id).pipe(Effect.forkChild)
    yield* server.wait(1).pipe(Effect.timeout("10 seconds"))
    expect(yield* work.get(root.id)).toEqual({ type: "working", foreground: "working", agents: 0, shells: 0 })
    yield* sessions.prompt({ sessionID: child.id, prompt: { text: "child work" }, resume: false })
    const descendant = yield* sessions.resume(child.id).pipe(Effect.forkChild)
    yield* server.wait(2).pipe(Effect.timeout("10 seconds"))
    const task = yield* jobs.start({ type: "task", metadata: { sessionId: child.id }, run: Effect.never })
    expect(yield* work.get(root.id)).toEqual({ type: "working", foreground: "working", agents: 1, shells: 0 })
    expect(yield* work.get(child.id)).toEqual({ type: "working", foreground: "working", agents: 0, shells: 0 })
    const answer = yield* QuestionV2.Service.use((questions) =>
      questions.ask({ sessionID: root.id, questions: [] }),
    ).pipe(Effect.provide(locations.get(root.location)), Effect.forkChild({ startImmediately: true }))
    const questions = yield* QuestionV2.Service.use((questions) => questions.list()).pipe(
      Effect.provide(locations.get(root.location)),
    )
    const question = questions.find((question) => question.sessionID === root.id)
    if (!question) return yield* Effect.die("Root question was not admitted")
    expect(yield* work.get(root.id)).toEqual({ type: "blocked", foreground: "working", agents: 1, shells: 0 })
    expect((yield* work.get(child.id)).type).toBe("working")
    yield* QuestionV2.Service.use((questions) => questions.reply({ requestID: question.id, answers: [] })).pipe(
      Effect.provide(locations.get(root.location)),
    )
    yield* Fiber.join(answer)
    releaseRoot.resolve()
    yield* Fiber.join(foreground)
    expect(yield* work.get(root.id)).toEqual({ type: "working", foreground: "idle", agents: 1, shells: 0 })
    releaseChild.resolve()
    yield* Fiber.join(descendant)
    expect(yield* work.get(root.id)).toEqual({ type: "working", foreground: "idle", agents: 1, shells: 0 })
    yield* jobs.cancel(task.id)
    expect(yield* work.get(root.id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
    expect(yield* server.calls).toBe(2)
    yield* server.hang
    yield* sessions.prompt({ sessionID: child.id, prompt: { text: "interrupt child" }, resume: false })
    const interrupted = yield* sessions.resume(child.id).pipe(Effect.forkChild)
    yield* server.wait(3).pipe(Effect.timeout("10 seconds"))
    expect((yield* work.get(root.id)).type).toBe("working")
    yield* sessions.interrupt(child.id)
    yield* Fiber.await(interrupted)
    expect(yield* work.get(root.id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
    expect(yield* server.misses).toEqual([])
  }),
)

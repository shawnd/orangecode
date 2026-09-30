import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { BackgroundJob } from "@/background/job"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { MessageID, PartID } from "@/session/schema"
import { SessionWorkState } from "@/session/work-state"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionWorkState.node,
      Session.node,
      SessionProjector.node,
      SessionStatus.node,
      BackgroundJob.node,
      Permission.node,
      Question.node,
    ]),
  ),
)

describe("aggregate session activity", () => {
  it.instance("ignores retained permission and question requests after their tool terminates or is removed", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const question = yield* Question.Service
      const activity = yield* SessionWorkState.Service
      const instance = yield* TestInstance
      const root = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: root.id })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: child.id,
        role: "user",
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        time: { created: Date.now() },
      })
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: child.id,
        role: "assistant",
        parentID: user.id,
        agent: "build",
        mode: "build",
        cost: 0,
        path: { cwd: instance.directory, root: instance.directory },
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test"),
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      const part: SessionV1.ToolPart = {
        id: PartID.ascending(),
        sessionID: child.id,
        messageID: assistant.id,
        callID: "retained-tool",
        tool: "bash",
        type: "tool",
        state: { status: "running", input: {}, metadata: {}, time: { start: 1 } },
      }
      yield* sessions.updatePart(part)
      const tool = { messageID: assistant.id, callID: part.callID }
      const ask = yield* permission
        .ask({
          sessionID: child.id,
          permission: "bash",
          patterns: ["build"],
          always: [],
          metadata: {},
          ruleset: [],
          tool,
        })
        .pipe(Effect.forkChild)
      const answer = yield* question
        .ask({ sessionID: child.id, questions: [], tool })
        .pipe(Effect.ignore, Effect.forkChild)
      const request = yield* pollWithTimeout(
        permission.list().pipe(Effect.map((requests) => requests[0])),
        "permission missing",
      )
      const prompt = yield* pollWithTimeout(
        question.list().pipe(Effect.map((requests) => requests[0])),
        "question missing",
      )
      expect((yield* activity.get(root.id)).type).toBe("blocked")
      yield* sessions.updatePart({
        ...part,
        state: {
          status: "completed",
          input: {},
          metadata: {},
          title: "finished",
          output: "done",
          time: { start: 1, end: 2 },
        },
      })
      expect((yield* activity.get(root.id)).type).toBe("idle")
      expect(yield* permission.list()).toHaveLength(1)
      expect(yield* question.list()).toHaveLength(1)
      yield* sessions.updatePart({
        ...part,
        state: { status: "error", input: {}, metadata: {}, error: "aborted", time: { start: 1, end: 2 } },
      })
      expect((yield* activity.get(root.id)).type).toBe("idle")
      yield* sessions.updatePart(part)
      expect((yield* activity.get(root.id)).type).toBe("blocked")
      yield* sessions.removePart({ sessionID: child.id, messageID: assistant.id, partID: part.id })
      expect((yield* activity.get(root.id)).type).toBe("idle")
      yield* sessions.removeMessage({ sessionID: child.id, messageID: assistant.id })
      expect((yield* activity.get(root.id)).type).toBe("idle")
      yield* permission.reply({ requestID: request.id, reply: "once" })
      yield* question.reject(prompt.id)
      yield* Fiber.join(ask)
      yield* Fiber.join(answer)
    }),
  )

  it.instance("keeps idle foreground working until nested agents and detached shells finish", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const statuses = yield* SessionStatus.Service
      const jobs = yield* BackgroundJob.Service
      const activity = yield* SessionWorkState.Service
      const root = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: root.id })
      const nested = yield* sessions.create({ parentID: child.id })
      const other = yield* sessions.create({})
      expect(yield* activity.get(root.id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })

      yield* statuses.set(child.id, { type: "busy" })
      yield* statuses.set(nested.id, { type: "retry", attempt: 1, message: "retrying", next: Date.now() + 1000 })
      yield* statuses.set(other.id, { type: "busy" })
      const agent = yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { sessionId: child.id, parentSessionId: root.id, background: true },
        run: Effect.never,
      })
      const done = yield* Deferred.make<string>()
      const shell = yield* jobs.start({
        type: "shell",
        metadata: { sessionId: nested.id, background: true },
        run: Deferred.await(done),
      })
      yield* jobs.start({ type: "shell", metadata: { sessionId: other.id, background: true }, run: Effect.never })
      expect(yield* activity.get(root.id)).toEqual({ type: "working", foreground: "idle", agents: 2, shells: 1 })
      expect(yield* statuses.get(root.id)).toEqual({ type: "idle" })

      yield* statuses.set(root.id, { type: "busy" })
      expect(yield* activity.get(root.id)).toEqual({ type: "working", foreground: "working", agents: 2, shells: 1 })
      yield* statuses.set(root.id, { type: "idle" })
      yield* statuses.set(child.id, { type: "idle" })
      yield* statuses.set(nested.id, { type: "idle" })
      // Job ownership closes the gap before an agent starts or between resumed turns.
      expect(yield* activity.get(root.id)).toEqual({ type: "working", foreground: "idle", agents: 1, shells: 1 })
      yield* jobs.cancel(agent.id)
      expect(yield* activity.get(root.id)).toEqual({ type: "working", foreground: "idle", agents: 0, shells: 1 })
      yield* Deferred.succeed(done, "finished")
      yield* jobs.wait({ id: shell.id })
      expect(yield* activity.get(root.id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
    }),
  )

  it.instance("child permissions and questions take precedence over other active work", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const statuses = yield* SessionStatus.Service
      const permission = yield* Permission.Service
      const question = yield* Question.Service
      const activity = yield* SessionWorkState.Service
      const root = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: root.id })
      const other = yield* sessions.create({})
      yield* statuses.set(child.id, { type: "busy" })
      const ask = yield* permission
        .ask({
          sessionID: child.id,
          permission: "edit",
          patterns: ["file.ts"],
          always: [],
          metadata: {},
          ruleset: [],
        })
        .pipe(Effect.forkChild)
      const request = yield* pollWithTimeout(
        permission.list().pipe(Effect.map((requests) => requests.find((request) => request.sessionID === child.id))),
        "permission was not asked",
      )
      expect(yield* activity.get(root.id)).toEqual({ type: "blocked", foreground: "idle", agents: 1, shells: 0 })
      yield* permission.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(ask)
      expect((yield* activity.get(root.id)).type).toBe("working")

      const answer = yield* question
        .ask({
          sessionID: child.id,
          questions: [
            { question: "Continue?", header: "Continue", options: [{ label: "Yes", description: "Continue" }] },
          ],
        })
        .pipe(Effect.forkChild)
      const prompt = yield* pollWithTimeout(
        question.list().pipe(Effect.map((requests) => requests.find((request) => request.sessionID === child.id))),
        "question was not asked",
      )
      expect((yield* activity.get(root.id)).type).toBe("blocked")
      yield* question.reply({ requestID: prompt.id, answers: [["Yes"]] })
      yield* Fiber.join(answer)
      yield* statuses.set(child.id, { type: "idle" })
      const unrelated = yield* question
        .ask({
          sessionID: other.id,
          questions: [{ question: "Unrelated?", header: "Other", options: [] }],
        })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        question.list().pipe(Effect.map((requests) => requests.find((request) => request.sessionID === other.id))),
        "unrelated question was not asked",
      )
      expect((yield* activity.get(root.id)).type).toBe("idle")
      yield* Fiber.interrupt(unrelated)
    }),
  )

  it.instance("failed and cancelled shells no longer keep the session working", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const activity = yield* SessionWorkState.Service
      const root = yield* sessions.create({})
      const failed = yield* jobs.start({
        type: "shell",
        metadata: { sessionId: root.id, background: true },
        run: Effect.fail(new Error("build failed")),
      })
      yield* jobs.wait({ id: failed.id })
      const cancelled = yield* jobs.start({
        type: "shell",
        metadata: { sessionId: root.id, background: true },
        run: Effect.never,
      })
      expect((yield* activity.get(root.id)).type).toBe("working")
      yield* jobs.cancel(cancelled.id)
      expect((yield* activity.get(root.id)).type).toBe("idle")
    }),
  )
})

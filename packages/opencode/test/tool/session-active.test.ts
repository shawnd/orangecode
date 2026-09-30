import { afterEach, describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Database } from "@opencode-ai/core/database/database"
import { SessionActivity } from "@opencode-ai/core/session/activity"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Todo } from "@/session/todo"
import { MessageID, PartID } from "@/session/schema"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionActiveTool } from "@/tool/session-active"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { disposeAllInstances, provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionStatus.node,
      SessionActivity.node,
      SessionProjector.node,
      Todo.node,
      Truncate.node,
      Agent.node,
      EventV2Bridge.node,
      Database.node,
      CrossSpawnSpawner.node,
      Ripgrep.node,
    ]),
  ),
)
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.session_active", () => {
  it.instance("lists work across projects, excludes self and idle history, and shows legacy and current context", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const activity = yield* SessionActivity.Service
      const todos = yield* Todo.Service
      const database = yield* Database.Service
      const self = yield* sessions.create({ title: "This session" })
      yield* status.set(self.id, { type: "busy" })
      const idle = yield* sessions.create({ title: "Recently updated but idle" })
      const local = yield* sessions.create({ title: "Fix tests" })
      yield* status.set(local.id, { type: "busy" })
      const message = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: local.id,
        role: "user",
        agent: "build",
        model,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: local.id,
        messageID: message.id,
        type: "text",
        text: "Fix the failing checkout tests",
      })
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: local.id,
        role: "assistant",
        parentID: message.id,
        agent: "build",
        mode: "build",
        ...model,
        path: { cwd: local.directory, root: local.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: local.id,
        messageID: assistant.id,
        type: "tool",
        tool: "bash",
        callID: "running",
        state: { status: "running", input: { command: "bun test" }, time: { start: Date.now() } },
      })
      yield* todos.update({
        sessionID: local.id,
        todos: [
          { content: "Investigate checkout failures", status: "in_progress", priority: "high" },
          { content: "Already completed", status: "completed", priority: "low" },
        ],
      })

      const dir = yield* tmpdirScoped({ git: true })
      const other = yield* Effect.gen(function* () {
        const other = yield* sessions.create({ title: "Other project deployment" })
        yield* status.set(other.id, {
          type: "retry",
          attempt: 1,
          message: "Provider rate limited",
          next: Date.now() + 1_000,
        })
        yield* database.db
          .run(sql`insert into ${SessionMessageTable} (id, session_id, type, seq, time_created, time_updated, data)
          values (${MessageID.ascending()}, ${other.id}, 'user', 1, ${Date.now()}, ${Date.now()}, ${JSON.stringify({ text: "Deploy the other application" })})`)
        yield* database.db
          .run(sql`insert into ${SessionMessageTable} (id, session_id, type, seq, time_created, time_updated, data)
          values (${MessageID.ascending()}, ${other.id}, 'assistant', 2, ${Date.now()}, ${Date.now()}, ${JSON.stringify({ content: [{ type: "tool", name: "apply_patch", state: { status: "running" } }] })})`)
        return other
      }).pipe(provideInstance(dir))

      const info = yield* SessionActiveTool
      const tool = yield* info.init()
      const ctx = {
        sessionID: self.id,
        messageID: MessageID.ascending(),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const result = yield* tool.execute({}, ctx)
      expect(result.metadata.sessions).toBe(2)
      expect(result.output).toContain(local.id)
      expect(result.output).toContain(local.directory)
      expect(result.output).toContain("Fix the failing checkout tests")
      expect(result.output).toContain("Investigate checkout failures")
      expect(result.output).toContain("Running tools: bash")
      expect(result.output).toContain(other.id)
      expect(result.output).toContain(dir)
      expect(result.output).toContain("Deploy the other application")
      expect(result.output).toContain("Provider rate limited")
      expect(result.output).toContain("Running tools: apply_patch")
      expect(result.output).not.toContain(self.id)
      expect(result.output).not.toContain(idle.id)
      expect(result.output).not.toContain("Already completed")
      expect((yield* tool.execute({ include_self: true }, ctx)).metadata.sessions).toBe(3)
      yield* status.set(local.id, { type: "idle" })
      yield* activity.set(other.id, { type: "idle" })
      expect((yield* tool.execute({}, ctx)).metadata.sessions).toBe(0)
    }),
  )
})

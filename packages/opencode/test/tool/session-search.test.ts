import { afterEach, describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      ToolRegistry.node,
      Agent.node,
      Session.node,
      SessionProjector.node,
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

describe("tool.session_search", () => {
  it.instance("finds legacy and current transcript text but excludes this session and tool content", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const old = yield* sessions.create({ title: "Pipeline discussion" })
      const active = yield* sessions.create({ title: "Active chat" })
      const legacy = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: old.id,
        agent: "build",
        model,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: old.id,
        messageID: legacy.id,
        type: "text",
        text: "Let's configure CI/CD for deploys",
      })
      const hidden = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: active.id,
        agent: "build",
        model,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: active.id,
        messageID: hidden.id,
        type: "text",
        text: "CI/CD only in active chat",
      })
      // Current-runner messages are stored separately from the legacy part table.
      const messageID = MessageID.ascending()
      yield* db.run(sql`insert into ${SessionMessageTable} (id, session_id, type, seq, time_created, time_updated, data)
        values (${messageID}, ${old.id}, 'assistant', 1, ${Date.now()}, ${Date.now()},
        ${JSON.stringify({
          content: [
            { type: "text", text: "Our CI/CD pipeline uses release jobs" },
            { type: "tool", state: { content: [{ text: "secret-only-keyword" }] } },
          ],
        })})`)
      const userID = MessageID.ascending()
      yield* db.run(sql`insert into ${SessionMessageTable} (id, session_id, type, seq, time_created, time_updated, data)
        values (${userID}, ${old.id}, 'user', 2, ${Date.now()}, ${Date.now()},
        ${JSON.stringify({ text: "What about scheduled releases?" })})`)
      const tool = (yield* registry.tools({ ...model, agent: yield* agents.get("build") })).find(
        (item) => item.id === "session_search",
      )
      expect(tool).toBeDefined()
      if (!tool) return
      const ctx = {
        sessionID: active.id,
        messageID: hidden.id,
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const result = yield* tool.execute({ query: "ci/cd" }, ctx)
      expect(result.output).toContain("Pipeline discussion")
      expect(result.output).toContain(old.id)
      expect(result.output).toContain(legacy.id)
      expect(result.output).toContain(messageID)
      expect(result.output).not.toContain(hidden.id)
      expect(result.output).toContain("CI/CD")
      expect(result.metadata.matches).toBe(2)

      const ignored = yield* tool.execute({ query: "secret-only-keyword" }, ctx)
      expect(ignored.metadata.matches).toBe(0)
      const user = yield* tool.execute({ query: "scheduled releases" }, ctx)
      expect(user.output).toContain(userID)
      expect(user.metadata.matches).toBe(1)
      const literal = yield* tool.execute({ query: "%" }, ctx)
      expect(literal.metadata.matches).toBe(0)
    }),
  )
})

import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      ToolRegistry.node,
      Agent.node,
      Session.node,
      EventV2Bridge.node,
      SessionProjector.node,
      Database.node,
      CrossSpawnSpawner.node,
      Ripgrep.node,
    ]),
  ),
)
const config = {
  provider: {
    usage: {
      npm: "@ai-sdk/openai-compatible",
      models: { "test-model": { limit: { context: 100_000, output: 10_000 } } },
    },
  },
}
const model = { providerID: ProviderV2.ID.make("usage"), modelID: ModelV2.ID.make("test-model") }

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.context_usage", () => {
  it.instance(
    "reports the last completed turn against the selected model's context window",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const agents = yield* Agent.Service
        const registry = yield* ToolRegistry.Service
        const chat = yield* sessions.create({ title: "Usage" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model,
          time: { created: Date.now() },
        })
        yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: user.id,
          sessionID: chat.id,
          agent: "build",
          mode: "build",
          modelID: model.modelID,
          providerID: model.providerID,
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 12_000, output: 300, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
          time: { created: Date.now(), completed: Date.now() },
        })
        const tool = (yield* registry.tools({ ...model, agent: yield* agents.get("build") })).find(
          (item) => item.id === "context_usage",
        )
        expect(tool).toBeDefined()
        if (!tool) return
        const result = yield* tool.execute(
          {},
          {
            sessionID: chat.id,
            messageID: user.id,
            agent: "build",
            abort: new AbortController().signal,
            messages: yield* sessions.messages({ sessionID: chat.id }),
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        expect(result.output).toContain("Model: usage/test-model")
        expect(result.output).toContain("12,300 tokens (12.3% of context window)")
        expect(result.output).toContain("Automatic compaction threshold: 50,000 tokens")
        expect(result.output).toContain("Input: 12,000 · Cache read: 0 · Cache write: 0 · Output: 300")
        expect(result.output).toContain("87,700 tokens")
        expect(result.output).toContain("Current in-flight turn")
      }),
    { config: { ...config, compaction: { threshold_percent: 50 } } },
  )

  it.instance(
    "does not report stale usage after switching models",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const agents = yield* Agent.Service
        const registry = yield* ToolRegistry.Service
        const chat = yield* sessions.create({ title: "Usage after switch" })
        const old = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: { ...model, modelID: ModelV2.ID.make("previous-model") },
          time: { created: Date.now() - 1000 },
        })
        yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: old.id,
          sessionID: chat.id,
          agent: "build",
          mode: "build",
          modelID: ModelV2.ID.make("previous-model"),
          providerID: model.providerID,
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 50_000, output: 1_000, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
          time: { created: Date.now() - 1000, completed: Date.now() - 1000 },
        })
        const current = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model,
          time: { created: Date.now() },
        })
        const tool = (yield* registry.tools({ ...model, agent: yield* agents.get("build") })).find(
          (item) => item.id === "context_usage",
        )
        expect(tool).toBeDefined()
        if (!tool) return
        const result = yield* tool.execute(
          {},
          {
            sessionID: chat.id,
            messageID: current.id,
            agent: "build",
            abort: new AbortController().signal,
            messages: yield* sessions.messages({ sessionID: chat.id }),
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        expect(result.output).toContain("no completed turn measured on this model yet")
        expect(result.output).not.toContain("51,000")
      }),
    { config },
  )
})

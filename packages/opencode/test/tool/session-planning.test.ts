import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { disposeAllInstances, provideInstance, tmpdirScoped } from "../fixture/fixture"
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

describe("tool.session_planning", () => {
  it.instance("lists pending plan-mode sessions and optionally includes itself", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const pending = yield* sessions.create({ title: "Pending plan", agent: "plan" })
      const self = yield* sessions.create({ title: "Current plan", agent: "plan" })
      const archived = yield* sessions.create({ title: "Archived plan", agent: "plan" })
      const build = yield* sessions.create({ title: "Build session", agent: "build" })
      yield* sessions.setArchived({ sessionID: archived.id, time: Date.now() })
      const other = yield* sessions
        .create({ title: "Other project's plan", agent: "plan" })
        .pipe(provideInstance(yield* tmpdirScoped({ git: true })))

      const tool = (yield* registry.tools({ ...model, agent: yield* agents.get("build") })).find(
        (item) => item.id === "session_planning",
      )
      expect(tool).toBeDefined()
      if (!tool) return

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
      expect(result.metadata.sessions).toBe(1)
      expect(result.output).toContain(pending.id)
      expect(result.output).toContain(pending.title)
      expect(result.output).toContain(pending.directory)
      expect(result.output).not.toContain(self.id)
      expect(result.output).not.toContain(archived.id)
      expect(result.output).not.toContain(build.id)
      expect(result.output).not.toContain(other.id)

      const withSelf = yield* tool.execute({ include_self: true }, ctx)
      expect(withSelf.metadata.sessions).toBe(2)
      expect(withSelf.output).toContain(self.id)

      yield* sessions.setArchived({ sessionID: pending.id, time: Date.now() })
      expect((yield* tool.execute({}, ctx)).metadata.sessions).toBe(0)

      const many = yield* Effect.forEach(Array.from({ length: 31 }), (_, i) =>
        sessions.create({ title: `Plan ${i}`, agent: "plan" }),
      )
      const all = yield* tool.execute({}, ctx)
      expect(all.metadata.sessions).toBe(31)
      many.forEach((session) => expect(all.output).toContain(session.id))
    }),
  )
})

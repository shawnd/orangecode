import { afterEach, describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionSwitchTool } from "@/tool/session-switch"
import { TuiEvent } from "@/server/tui-event"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Session.node, SessionProjector.node, EventV2Bridge.node, Truncate.node, Agent.node]),
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.session_switch", () => {
  it.instance("opens an existing session without moving the running turn", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const source = yield* sessions.create({ title: "Source" })
      const target = yield* sessions.create({ title: "Deployment notes" })
      const selected: string[] = []
      const off = yield* events.listen((event) => {
        if (event.type === TuiEvent.SessionSelect.type)
          selected.push(Schema.decodeUnknownSync(TuiEvent.SessionSelect.data)(event.data).sessionID)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)

      const info = yield* SessionSwitchTool
      const tool = yield* info.init()
      const ctx = {
        sessionID: source.id,
        messageID: MessageID.ascending(),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const result = yield* tool.execute({ sessionID: target.id }, ctx)
      expect(result.output).toContain("Deployment notes")
      expect(result.metadata.switched).toBe(true)
      expect(selected).toEqual([target.id])

      const missing = yield* tool.execute({ sessionID: SessionID.make("ses_missing") }, ctx)
      expect(missing.metadata.switched).toBe(false)
      expect(selected).toEqual([target.id])

      const same = yield* tool.execute({ sessionID: source.id }, ctx)
      expect(same.metadata.switched).toBe(false)
      expect(selected).toEqual([target.id])
    }),
  )
})

import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Database } from "@opencode-ai/core/database/database"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { ShareNext } from "../../src/share/share-next"
import { Session } from "../../src/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Provider } from "../../src/provider/provider"

export function sharingFixture(options?: { modelGate?: Effect.Effect<void> }) {
  const work = { registered: 0, retained: 0, callbacks: 0, clones: 0, clonePayloadBytes: 0, models: 0 }
  const observation = { active: 0 }
  const requests: Array<{ method: string; url: string; body: string }> = []
  const client = HttpClient.make((req) => {
    requests.push({
      method: req.method,
      url: req.url,
      body: req.body._tag === "Uint8Array" ? new TextDecoder().decode(req.body.body) : "",
    })
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        req,
        Response.json({ id: "shr_probe", secret: "secret", url: "https://share.example/probe" }),
      ),
    )
  })
  // Decorate only this fixture's services; every callback/publication and lookup
  // still runs through the real EventV2, bridge and Provider implementations.
  const bridge = Layer.effect(
    EventV2Bridge.Service,
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      return EventV2Bridge.Service.of({
        ...events,
        listen: (callback) =>
          Effect.gen(function* () {
            const off = yield* events.listen((event) =>
              Effect.gen(function* () {
                work.callbacks++
                observation.active++
                yield* Effect.suspend(() => callback(event)).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      observation.active--
                    }),
                  ),
                )
              }),
            )
            work.registered++
            work.retained++
            return off.pipe(Effect.tap(() => Effect.sync(() => work.retained--)))
          }),
      })
    }),
  ).pipe(Layer.provide(LayerNode.compile(EventV2Bridge.node)))
  const provider = Layer.effect(
    Provider.Service,
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      return Provider.Service.of({
        ...provider,
        getModel: (providerID, modelID) =>
          Effect.gen(function* () {
            work.models++
            if (options?.modelGate) yield* options.modelGate
            return yield* provider.getModel(providerID, modelID)
          }),
      })
    }),
  ).pipe(Layer.provide(LayerNode.compile(Provider.node)))
  const layer = LayerNode.compile(
    LayerNode.group([ShareNext.node, EventV2Bridge.node, Session.node, SessionProjector.node, Database.node]),
    [
      [httpClient, Layer.succeed(HttpClient.HttpClient, client)],
      [EventV2Bridge.node, bridge],
      [Provider.node, provider],
    ],
  )

  function tracked<A extends object>(data: A, bytes = 0): A {
    // Count getter visits only while a sharing callback runs, excluding durable
    // encoding/projector reads. Publications in the probe are sequential.
    // structuredClone visits this getter; no global clone spy is necessary.
    return Object.defineProperty(data, "sharingCloneProbe", {
      enumerable: true,
      get() {
        if (!observation.active) return true
        work.clones++
        work.clonePayloadBytes += bytes
        return true
      },
    })
  }

  return { work, requests, layer, tracked }
}

export const sharingConfig = {
  enterprise: { url: "https://share.example" },
  provider: { openai: { options: { apiKey: "isolated-test-key" } } },
}

export const seedShare = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db
      .insert(SessionShareTable)
      .values({
        session_id: sessionID,
        id: `shr_${sessionID}`,
        secret: "secret",
        url: "https://share.example/probe",
      })
      .run()
      .pipe(Effect.orDie)
  })

export function sharingPayloads(sessionID: SessionID, fixture: ReturnType<typeof sharingFixture>, bytes = 262144) {
  const messageID = MessageID.ascending()
  const user = fixture.tracked({
    id: messageID,
    sessionID,
    role: "user" as const,
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4o") },
  })
  const part = fixture.tracked(
    {
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "tool" as const,
      callID: "call_probe",
      tool: "bash",
      state: {
        status: "completed" as const,
        input: { command: "fixture" },
        output: "x".repeat(bytes),
        title: "fixture",
        metadata: {},
        time: { start: 0, end: 1 },
      },
    },
    bytes,
  )
  const diff = [
    fixture.tracked(
      { file: "probe.ts", patch: "y".repeat(bytes), additions: 1, deletions: 1, status: "modified" as const },
      bytes,
    ),
  ]
  return { user, part, diff }
}

export const publishSharingBatch = (payload: ReturnType<typeof sharingPayloads>) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    yield* events.publish(MessageV2.Event.Updated, { sessionID: payload.user.sessionID, info: payload.user })
    yield* events.publish(MessageV2.Event.PartUpdated, {
      sessionID: payload.part.sessionID,
      part: payload.part,
      time: 1,
    })
    yield* events.publish(Session.Event.Diff, { sessionID: payload.user.sessionID, diff: payload.diff })
  })

import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { GlobalBus } from "../../src/bus/global"
import { makeEventInterest } from "../../src/server/event-interest"
import { eventResponse } from "../../src/server/routes/instance/httpapi/handlers/global"
import { Database } from "@opencode-ai/core/database/database"
import { testEffect } from "../lib/effect"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { createClient } from "@opencode-ai/sdk/v2/gen/client"

const it = testEffect(Database.layerFromPath(":memory:"))

test("generated SDK keeps first-argument event options and client overrides", async () => {
  const requests: Request[] = []
  const target = createClient({
    baseUrl: "http://options-test",
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init))
        return new Response('data: {"payload":{"type":"server.connected","properties":{}}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        })
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const source = createOpencodeClient({ baseUrl: "http://wrong-client" })
  const events = await source.global.event({
    client: target,
    headers: { "x-options": "legacy" },
    sseMaxRetryAttempts: 0,
  })
  for await (const event of events.stream) expect(event.payload.type).toBe("server.connected")
  expect(requests[0]?.url).toBe("http://options-test/global/event")
  expect(requests[0]?.headers.get("x-options")).toBe("legacy")
})

test("opt-in filtering preserves global metadata and legacy delivery", () => {
  const interest = makeEventInterest("root")
  const event = (type: string, properties: unknown) => ({ payload: { type, properties } })
  expect(interest.accepts(event("message.updated", { info: { sessionID: "other" } }))).toBe(false)
  expect(interest.accepts(event("session.status", { sessionID: "other" }))).toBe(true)
  expect(interest.accepts(event("permission.asked", { sessionID: "other" }))).toBe(true)
  expect(interest.accepts(event("question.asked", { sessionID: "other" }))).toBe(true)
  expect(interest.accepts(event("session.updated", { info: { id: "other", cost: 10 } }))).toBe(true)
  interest.accepts(event("session.created", { info: { id: "child", parentID: "root" } }))
  interest.accepts(event("session.created", { info: { id: "grandchild", parentID: "child" } }))
  expect(interest.accepts(event("todo.updated", { sessionID: "grandchild" }))).toBe(true)
  expect(interest.accepts(event("session.next.step.ended", { sessionID: "child", cost: 2 }))).toBe(true)
  expect(
    interest.accepts({
      payload: {
        type: "sync",
        syncEvent: { type: "session.next.text.delta.1", aggregateID: "other", data: { delta: "private" } },
      },
    }),
  ).toBe(false)
  expect(makeEventInterest("").accepts(event("message.part.delta", { sessionID: "root" }))).toBe(false)
})

test("production SSE drops unrelated transcripts before JSON and installs listener before connected", async () => {
  const before = GlobalBus.listenerCount("event")
  const response = HttpServerResponse.toWeb(await Effect.runPromise(eventResponse(makeEventInterest("root"))))
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("server.connected")
  expect(GlobalBus.listenerCount("event")).toBe(before + 1)
  let serialized = 0
  GlobalBus.emit("event", {
    payload: {
      type: "message.part.delta",
      properties: {
        sessionID: "other",
        get delta() {
          serialized++
          throw new Error("Unrelated event serialized")
        },
      },
    },
  })
  GlobalBus.emit("event", {
    payload: { type: "session.status", properties: { sessionID: "other", status: { type: "busy" } } },
  })
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("session.status")
  expect(serialized).toBe(0)
  await reader.cancel()
  expect(GlobalBus.listenerCount("event")).toBe(before)
})

it.live("connected seeds persisted descendants before their first transcript event", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    // Persisted ancestry intentionally exists before any runtime Session event.
    yield* database.db.run(
      "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('proj_interest', '/tmp/opencode-interest', 0, 0, '[]')",
    )
    yield* database.db
      .run(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES
    ('ses_root', 'proj_interest', NULL, 'root', '/tmp/opencode-interest', 'root', 'test', 0, 0),
    ('ses_child', 'proj_interest', 'ses_root', 'child', '/tmp/opencode-interest', 'child', 'test', 0, 0),
    ('ses_grandchild', 'proj_interest', 'ses_child', 'grandchild', '/tmp/opencode-interest', 'grandchild', 'test', 0, 0),
    ('ses_unrelated', 'proj_interest', NULL, 'unrelated', '/tmp/opencode-interest', 'unrelated', 'test', 0, 0)`)
    const before = GlobalBus.listenerCount("event")
    const response = HttpServerResponse.toWeb(yield* eventResponse(makeEventInterest("ses_root"), database.db))
    const reader = response.body!.getReader()
    yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel()))
    const connected = new TextDecoder().decode((yield* Effect.promise(() => reader.read())).value)
    expect(connected).toContain('"id":"ses_child","parentID":"ses_root"')
    expect(connected).toContain('"id":"ses_grandchild","parentID":"ses_child"')
    expect(connected).not.toContain("ses_unrelated")
    GlobalBus.emit("event", {
      payload: {
        type: "message.part.delta",
        properties: {
          sessionID: "ses_grandchild",
          messageID: "msg_child",
          partID: "part_child",
          field: "text",
          delta: "seeded",
        },
      },
    })
    expect(new TextDecoder().decode((yield* Effect.promise(() => reader.read())).value)).toContain("seeded")
    yield* Effect.promise(() => reader.cancel())
    expect(GlobalBus.listenerCount("event")).toBe(before)
  }),
)

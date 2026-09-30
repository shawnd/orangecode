import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { GlobalBus } from "../../src/bus/global"
import { makeEventInterest } from "../../src/server/event-interest"
import { eventResponse } from "../../src/server/routes/instance/httpapi/handlers/global"

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
  expect(interest.accepts({ payload: { type: "sync", syncEvent: { type: "session.next.text.delta.1", aggregateID: "other", data: { delta: "private" } } } })).toBe(false)
  expect(makeEventInterest("").accepts(event("message.part.delta", { sessionID: "root" }))).toBe(false)
})

test("production SSE drops unrelated transcripts before JSON and installs listener before connected", async () => {
  const before = GlobalBus.listenerCount("event")
  const response = HttpServerResponse.toWeb(await Effect.runPromise(eventResponse(makeEventInterest("root"))))
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("server.connected")
  expect(GlobalBus.listenerCount("event")).toBe(before + 1)
  let serialized = 0
  GlobalBus.emit("event", { payload: { type: "message.part.delta", properties: {
    sessionID: "other", get delta() { serialized++; throw new Error("Unrelated event serialized") },
  } } })
  GlobalBus.emit("event", { payload: { type: "session.status", properties: { sessionID: "other", status: { type: "busy" } } } })
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("session.status")
  expect(serialized).toBe(0)
  await reader.cancel()
  expect(GlobalBus.listenerCount("event")).toBe(before)
})

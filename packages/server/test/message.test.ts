import { expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "../../core/test/lib/effect"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionTable, SessionMessageTable } from "@opencode-ai/core/session/sql"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { SessionMessagesResponse } from "@opencode-ai/protocol/groups/message"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { fixture } from "./fixture"
import { MessageHandler } from "../src/handlers/message"

const it = testEffect(Layer.empty)
const sessionID = SessionV2.ID.make("ses_cache_test")
const timestamp = DateTime.makeUnsafe(0)
const parse = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.toCodecJson(SessionMessagesResponse)))

it.live("canonical response parity, normalized defaults and separate cursors/orders/limits", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.seed(sessionID)
    yield* Effect.forEach(Array.from({ length: 5 }), (_, i) =>
      f.events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        timestamp,
        messageID: SessionMessage.ID.make(`msg_cache_${i}`),
        agent: i % 2 ? "plan" : "build",
      }),
    )
    const first = yield* f.request(sessionID)
    expect(first.status).toBe(200)
    const canonical = yield* f.sessions.messages({ sessionID, order: "desc", limit: 50 })
    const decoded = parse(first.text)
    expect(decoded.data).toEqual(canonical)
    expect(decoded.sequence).toBe(4)
    expect((yield* f.request(sessionID, "?limit=50&order=desc")).text).toBe(first.text)
    expect(f.counts.reads).toBe(2) // one HTTP miss and the explicit canonical read
    expect(f.counts.placements).toBe(2)
    const asc = parse((yield* f.request(sessionID, "?limit=2&order=asc")).text)
    expect(asc.data.map((m) => String(m.id))).toEqual(["msg_cache_0", "msg_cache_1"])
    const next = parse((yield* f.request(sessionID, `?limit=2&cursor=${asc.cursor.next}`)).text)
    expect(next.data.map((m) => String(m.id))).toEqual(["msg_cache_2", "msg_cache_3"])
    const previous = yield* f.request(sessionID, `?limit=2&cursor=${next.cursor.previous}`)
    expect(parse(previous.text).data).toEqual(asc.data)
    const empty = yield* f.request(sessionID, `?limit=2&cursor=${asc.cursor.previous}`)
    expect(JSON.parse(empty.text)).toEqual({ data: [], sequence: 4, cursor: { previous: null, next: null } })
    const emptyReads = f.counts.reads
    expect((yield* f.request(sessionID, `?limit=2&cursor=${asc.cursor.previous}`)).text).toBe(empty.text)
    expect(f.counts.reads).toBe(emptyReads)
    const absent = Buffer.from(JSON.stringify({ id: "msg_absent", order: "asc", direction: "next" })).toString(
      "base64url",
    )
    expect(parse((yield* f.request(sessionID, `?cursor=${absent}`)).text).data).toEqual([])
    const longer = parse((yield* f.request(sessionID, "?limit=3&order=asc")).text)
    expect(longer.data).toHaveLength(3)
    const reads = f.counts.reads
    expect((yield* f.request(sessionID, `?limit=2&cursor=${next.cursor.previous}`)).text).toBe(previous.text)
    expect(f.counts.reads).toBe(reads)
    for (const query of ["?cursor=bad", "?limit=0", "?limit=201", `?cursor=${asc.cursor.next}&order=desc`]) {
      expect((yield* f.request(sessionID, query)).status).toBe(400)
    }
  }),
)

it.live("hits still acquire placement/check credentials/existence and never share mutable bodies", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.seed(sessionID)
    yield* f.events.publish(SessionEvent.AgentSwitched, {
      sessionID,
      timestamp,
      messageID: SessionMessage.ID.make("msg_auth"),
      agent: "plan",
    })
    const first = yield* f.request(sessionID)
    const poisoned = JSON.parse(first.text)
    poisoned.data[0].agent = "poisoned"
    expect((yield* f.request(sessionID)).text).toBe(first.text)
    expect(f.counts.reads).toBe(1)
    expect(f.counts.placements).toBe(2)
    expect((yield* f.request(sessionID, "", "Basic invalid")).status).toBe(401)
    // Production authorization reads the same live config object on each request.
    f.auth.username = "revoked"
    expect((yield* f.request(sessionID)).status).toBe(401)
    f.auth.username = "test"
    yield* f.db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
    expect((yield* f.request(sessionID)).status).toBe(404)
  }),
)

it.live("session/database isolation, fresh Location move and durable mutations invalidate", () =>
  Effect.gen(function* () {
    const a = yield* fixture()
    const b = yield* fixture()
    yield* a.seed(sessionID)
    yield* b.seed(sessionID)
    yield* a.events.publish(SessionEvent.AgentSwitched, {
      sessionID,
      timestamp,
      messageID: SessionMessage.ID.make("msg_a"),
      agent: "plan",
    })
    yield* b.events.publish(SessionEvent.AgentSwitched, {
      sessionID,
      timestamp,
      messageID: SessionMessage.ID.make("msg_b"),
      agent: "build",
    })
    const first = yield* a.request(sessionID)
    expect((yield* b.request(sessionID)).text).not.toBe(first.text)
    yield* a.seed("ses_other")
    yield* a.events.publish(SessionEvent.AgentSwitched, {
      sessionID: SessionV2.ID.make("ses_other"),
      timestamp,
      messageID: SessionMessage.ID.make("msg_other"),
      agent: "build",
    })
    expect((yield* a.request("ses_other")).text).not.toBe(first.text)
    yield* a.events.publish(SessionEvent.Moved, {
      sessionID,
      timestamp,
      location: { directory: AbsolutePath.make(a.directory + "/moved") },
    })
    expect(parse((yield* a.request(sessionID)).text).sequence).toBe(1)
    yield* a.events.publish(SessionEvent.AgentSwitched, {
      sessionID,
      timestamp,
      messageID: SessionMessage.ID.make("msg_new"),
      agent: "build",
    })
    const final = yield* a.request(sessionID)
    expect(parse(final.text).data).toHaveLength(2)
    expect(parse(final.text).sequence).toBe(2)
    expect((yield* a.request(sessionID)).text).toBe(final.text)
    expect(a.counts.reads).toBe(4)
  }),
)

it.live("actual live text/reasoning/tool deltas do not mutate SQL pages; durable full values do", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.seed(sessionID)
    const assistantMessageID = SessionMessage.ID.make("msg_assistant")
    yield* f.events.publish(SessionEvent.Step.Started, {
      sessionID,
      timestamp,
      assistantMessageID,
      agent: "build",
      model: { id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") },
    })
    yield* f.events.publish(SessionEvent.Text.Started, { sessionID, timestamp, assistantMessageID, textID: "text" })
    yield* f.events.publish(SessionEvent.Reasoning.Started, {
      sessionID,
      timestamp,
      assistantMessageID,
      reasoningID: "reason",
    })
    yield* f.events.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      timestamp,
      assistantMessageID,
      callID: "tool",
      name: "bash",
    })
    const first = yield* f.request(sessionID)
    yield* f.events.publish(SessionEvent.Text.Delta, {
      sessionID,
      timestamp,
      assistantMessageID,
      textID: "text",
      delta: "live",
    })
    yield* f.events.publish(SessionEvent.Reasoning.Delta, {
      sessionID,
      timestamp,
      assistantMessageID,
      reasoningID: "reason",
      delta: "live",
    })
    yield* f.events.publish(SessionEvent.Tool.Input.Delta, {
      sessionID,
      timestamp,
      assistantMessageID,
      callID: "tool",
      delta: "live",
    })
    expect((yield* f.request(sessionID)).text).toBe(first.text)
    expect(f.counts.reads).toBe(1)
    expect([...(yield* f.sessions.messages({ sessionID, limit: 50, order: "desc" }))]).toEqual([
      ...parse(first.text).data,
    ])
    yield* f.events.publish(SessionEvent.Text.Ended, {
      sessionID,
      timestamp,
      assistantMessageID,
      textID: "text",
      text: "durable",
    })
    yield* f.events.publish(SessionEvent.Reasoning.Ended, {
      sessionID,
      timestamp,
      assistantMessageID,
      reasoningID: "reason",
      text: "durable",
    })
    yield* f.events.publish(SessionEvent.Tool.Input.Ended, {
      sessionID,
      timestamp,
      assistantMessageID,
      callID: "tool",
      text: "durable",
    })
    const final = yield* f.request(sessionID)
    expect(final.text).toContain("durable")
    expect(parse(final.text).sequence).toBe(6)
    expect(final.text).not.toBe(first.text)
  }),
)

it.live("concurrent readers/writers retain the SQL sequence fence", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.seed(sessionID)
    const [, pages] = yield* Effect.all(
      [
        Effect.forEach(Array.from({ length: 32 }), (_, i) =>
          f.events.publish(SessionEvent.AgentSwitched, {
            sessionID,
            timestamp,
            messageID: SessionMessage.ID.make(`msg_fence_${i}`),
            agent: "build",
          }),
        ),
        Effect.forEach(Array.from({ length: 48 }), () => f.request(sessionID, "?order=asc")),
      ],
      { concurrency: "unbounded" },
    )
    const final = parse((yield* f.request(sessionID, "?order=asc")).text)
    for (const page of pages) {
      expect(page.status).toBe(200)
      const body = parse(page.text)
      expect(body.sequence).toBeDefined()
      expect(body.data.length).toBe((body.sequence ?? -1) + 1)
      expect(body.data).toEqual(final.data.slice(0, body.data.length))
    }
  }),
)

it.live("unfenced legacy pages and decode/response validation errors are not retained", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.seed(sessionID)
    yield* f.request(sessionID)
    yield* f.request(sessionID)
    expect(f.counts.reads).toBe(2)
    yield* f.events.publish(SessionEvent.AgentSwitched, {
      sessionID,
      timestamp,
      messageID: SessionMessage.ID.make("msg_invalid"),
      agent: "build",
    })
    yield* f.db.run(`UPDATE session_message SET data = '{}' WHERE session_id = '${sessionID}'`)
    expect((yield* f.request(sessionID)).status).toBe(500)
    expect((yield* f.request(sessionID)).status).toBe(500)
    expect(f.counts.reads).toBe(4)
    yield* f.db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, sessionID)).run()
    yield* f.db.update(EventSequenceTable).set({ seq: 0.5 }).where(eq(EventSequenceTable.aggregate_id, sessionID)).run()
    expect((yield* f.request(sessionID)).status).toBe(400)
    expect((yield* f.request(sessionID)).status).toBe(400)
    expect(f.counts.reads).toBe(6)
  }),
)

it.live("production handler skips oversized pages without truncating responses", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.seed(sessionID)
    yield* f.events.publish(SessionEvent.Synthetic, {
      sessionID,
      timestamp,
      messageID: SessionMessage.ID.make("msg_large"),
      text: "😀".repeat(1024 * 1024),
    })
    const first = yield* f.request(sessionID)
    expect(first.status).toBe(200)
    expect(Buffer.byteLength(first.text)).toBeGreaterThan(4 * 1024 * 1024)
    expect((yield* f.request(sessionID)).text).toBe(first.text)
    expect(f.counts.reads).toBe(2)
  }),
)

it.live("same-sequence placement changes miss and cached pages cannot hide invalid fresh session info", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.seed(sessionID)
    yield* f.events.publish(SessionEvent.AgentSwitched, {
      sessionID,
      timestamp,
      messageID: SessionMessage.ID.make("msg_placement"),
      agent: "plan",
    })
    const first = yield* f.request(sessionID)
    yield* f.db
      .update(SessionTable)
      .set({ directory: f.directory + "/moved" })
      .where(eq(SessionTable.id, sessionID))
      .run()
    expect((yield* f.request(sessionID)).text).toBe(first.text)
    expect(f.counts.reads).toBe(2)
    yield* f.db.run(`UPDATE session SET model = '{}' WHERE id = '${sessionID}'`)
    expect((yield* f.request(sessionID)).status).toBe(500)
    expect(f.counts.reads).toBe(2)
    yield* f.db.update(SessionTable).set({ model: null }).where(eq(SessionTable.id, sessionID)).run()
    expect((yield* f.request(sessionID)).text).toBe(first.text)
    expect(f.counts.reads).toBe(2)
    expect(f.counts.placements).toBe(4)
  }),
)

it.live("independent WAL connection commits cannot mix a newer page with an older cached sequence", () =>
  Effect.gen(function* () {
    const owner = yield* fixture()
    const reader = yield* fixture(MessageHandler, owner.directory + "/shared.db")
    const writer = yield* fixture(MessageHandler, owner.directory + "/shared.db")
    yield* reader.seed(sessionID)
    const [, pages] = yield* Effect.all(
      [
        Effect.forEach(Array.from({ length: 24 }), (_, i) =>
          writer.events.publish(SessionEvent.AgentSwitched, {
            sessionID,
            timestamp,
            messageID: SessionMessage.ID.make(`msg_wal_${i}`),
            agent: "build",
          }),
        ),
        Effect.forEach(Array.from({ length: 36 }), () => reader.request(sessionID, "?order=asc")),
      ],
      { concurrency: "unbounded" },
    )
    const final = parse((yield* reader.request(sessionID, "?order=asc")).text)
    expect(final.sequence).toBe(23)
    expect(final.data).toHaveLength(24)
    for (const page of pages) {
      expect(page.status).toBe(200)
      const body = parse(page.text)
      expect(body.data.length).toBe((body.sequence ?? -1) + 1)
      expect(body.data).toEqual(final.data.slice(0, body.data.length))
    }
  }),
)

it.live("recreated Session IDs cannot reuse a cached page at the same sequence and placement", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.seed(sessionID)
    yield* f.events.publish(SessionEvent.AgentSwitched, {
      sessionID,
      timestamp,
      messageID: SessionMessage.ID.make("msg_old_incarnation"),
      agent: "plan",
    })
    const old = yield* f.request(sessionID)
    expect(parse(old.text).sequence).toBe(0)
    yield* f.db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
    yield* f.events.remove(sessionID)
    // No intermediate HTTP 404 is necessary for correctness. A fast recreate
    // at identical placement/sequence must miss on its different durable event.
    yield* f.seed(sessionID)
    yield* f.events.publish(SessionEvent.AgentSwitched, {
      sessionID,
      timestamp,
      messageID: SessionMessage.ID.make("msg_new_incarnation"),
      agent: "build",
    })
    const fresh = yield* f.request(sessionID)
    expect(parse(fresh.text).sequence).toBe(0)
    expect(parse(fresh.text).data.map((message) => String(message.id))).toEqual(["msg_new_incarnation"])
    expect(fresh.text).not.toBe(old.text)
    expect(f.counts.reads).toBe(2)
    expect((yield* f.request(sessionID)).text).toBe(fresh.text)
    expect(f.counts.reads).toBe(2)
  }),
)

it.live("a restored sequence without its durable revision is uncached until real publication", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.seed(sessionID)
    yield* f.db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 10 }).run()
    expect((yield* f.request(sessionID)).status).toBe(200)
    expect((yield* f.request(sessionID)).status).toBe(200)
    expect(f.counts.reads).toBe(2)
    yield* f.events.publish(SessionEvent.AgentSwitched, {
      sessionID,
      timestamp,
      messageID: SessionMessage.ID.make("msg_restored"),
      agent: "build",
    })
    const first = yield* f.request(sessionID)
    expect(parse(first.text).sequence).toBe(11)
    expect((yield* f.request(sessionID)).text).toBe(first.text)
    expect(f.counts.reads).toBe(3)
  }),
)

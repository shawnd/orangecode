/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { SDKProvider, useSDK } from "../../../src/context/sdk"
import { DataProvider, useData } from "../../../src/context/data"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { mount, wait } from "../cmd/tui/sync-fixture"

test("selective hydration replays newer durable commits and preserves live-only deltas", async () => {
  const previous = process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
  process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = "1"
  const events = createEventSource()
  const response = Promise.withResolvers<Response>()
  let requested = false
  const calls = createFetch((url) => {
    if (url.pathname !== "/api/session/ses_race/message") return
    requested = true
    return response.promise
  }, events)
  let sdk!: ReturnType<typeof useSDK>
  let data!: ReturnType<typeof useData>
  function Probe() {
    sdk = useSDK()
    data = useData()
    sdk.interest.select("ses_race")
    return <box />
  }
  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <DataProvider>
          <Probe />
        </DataProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))
  try {
    const hydration = data.session.message.refresh("ses_race")
    await wait(() => requested)
    events.emit({
      directory,
      payload: {
        id: "evt_started",
        type: "sync",
        syncEvent: {
          id: "evt_started",
          type: "session.next.text.started.1",
          seq: 11,
          aggregateID: "ses_race",
          data: { sessionID: "ses_race", assistantMessageID: "msg_race", textID: "txt_race", timestamp: 1 },
        },
      },
    })
    events.emit({
      directory,
      payload: {
        id: "evt_delta",
        type: "session.next.text.delta",
        properties: {
          sessionID: "ses_race",
          assistantMessageID: "msg_race",
          textID: "txt_race",
          timestamp: 2,
          delta: "live",
        },
      },
    })
    response.resolve(
      json({
        sequence: 10,
        cursor: {},
        data: [
          {
            id: "msg_race",
            type: "assistant",
            agent: "build",
            model: { id: "fake", providerID: "local" },
            content: [],
            time: { created: 0 },
          },
        ],
      }),
    )
    await hydration
    const live = data.session.message.list("ses_race")?.[0]
    expect(live?.type === "assistant" && live.content[0]?.type === "text" ? live.content[0].text : undefined).toBe(
      "live",
    )
    const ended = {
      directory,
      payload: {
        id: "evt_ended",
        type: "sync",
        syncEvent: {
          id: "evt_ended",
          type: "session.next.text.ended.1",
          seq: 12,
          aggregateID: "ses_race",
          data: {
            sessionID: "ses_race",
            assistantMessageID: "msg_race",
            textID: "txt_race",
            timestamp: 3,
            text: "complete",
          },
        },
      },
    } satisfies GlobalEvent
    events.emit(ended)
    sdk.flushEvents()
    events.emit({
      directory,
      payload: {
        id: "evt_stale",
        type: "sync",
        syncEvent: {
          id: "evt_stale",
          type: "session.next.text.started.1",
          seq: 11,
          aggregateID: "ses_race",
          data: { sessionID: "ses_race", assistantMessageID: "msg_race", textID: "txt_race", timestamp: 1 },
        },
      },
    })
    events.emit(ended)
    sdk.flushEvents()
    const assistant = data.session.message.list("ses_race")?.[0]
    expect(
      assistant?.type === "assistant" && assistant.content[0]?.type === "text" ? assistant.content[0].text : undefined,
    ).toBe("complete")
    expect(assistant?.type === "assistant" ? assistant.content.length : undefined).toBe(1)
    sdk.interest.select("ses_other")
    expect(data.session.message.list("ses_race")).toBeUndefined()
  } finally {
    app.renderer.destroy()
    if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
    if (previous !== undefined) process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = previous
  }
})

test("two attached clients keep navigation view-only and submission/adoption authority independent", async () => {
  const previous = process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
  process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = "1"
  const replies: string[][] = [[], []]
  const clients = await Promise.all(
    replies.map((requests, index) =>
      mount((url) => {
        if (url.pathname.includes("/permission/") || url.pathname.includes("/permissions/")) {
          requests.push(url.pathname)
          return json(true)
        }
        if (url.pathname === "/api/session/ses_owned/prompt" || url.pathname === "/session/ses_legacy/message") {
          expect(clients[index].sdk.interest.owns(url.pathname.split("/").at(-2)!)).toBe(true)
          return json({})
        }
      }),
    ),
  )
  try {
    clients.forEach((client) => {
      client.permission.set("auto")
      client.route.navigate({ type: "session", sessionID: "ses_owned" })
    })
    const asked = {
      directory,
      payload: {
        id: "evt_asked",
        type: "permission.v2.asked",
        properties: {
          id: "per_view",
          sessionID: "ses_owned",
          action: "bash",
          resources: ["pwd"],
        },
      },
    } satisfies GlobalEvent
    clients.forEach((client) => {
      client.emit(asked)
      client.sdk.flushEvents()
    })
    expect(replies).toEqual([[], []])
    await clients[0].sdk.client.v2.session.prompt({ sessionID: "ses_owned", prompt: { text: "run pwd" } })
    expect(clients[0].sdk.interest.owns("ses_owned")).toBe(true)
    expect(clients[1].sdk.interest.owns("ses_owned")).toBe(false)
    clients.forEach((client) => {
      client.emit(asked)
      client.sdk.flushEvents()
    })
    await wait(() => replies[0].length === 1)
    expect(replies[1]).toEqual([])
    clients[1].sdk.adoptSession("ses_owned")
    clients[1].emit(asked)
    clients[1].sdk.flushEvents()
    await wait(() => replies[1].length === 1)
    await clients[0].sdk.client.session.prompt({ sessionID: "ses_legacy", parts: [{ type: "text", text: "hello" }] })
    expect(clients[0].sdk.interest.owns("ses_legacy")).toBe(true)
    expect(clients[1].sdk.interest.owns("ses_legacy")).toBe(false)
    const legacy = {
      directory,
      payload: {
        id: "evt_legacy",
        type: "permission.asked",
        properties: {
          id: "per_legacy",
          sessionID: "ses_legacy",
          permission: "bash",
          patterns: ["pwd"],
          always: [],
          metadata: {},
        },
      },
    } satisfies GlobalEvent
    clients.forEach((client) => {
      client.emit(legacy)
      client.sdk.flushEvents()
    })
    await wait(() => replies[0].length === 2)
    expect(replies[1].length).toBe(1)
    expect(clients[1].sync.data.permission.ses_legacy?.[0].id).toBe("per_legacy")
    clients.forEach((client) => {
      client.emit({
        directory,
        payload: {
          id: "evt_unseen",
          type: "session.status",
          properties: {
            sessionID: "ses_unseen",
            status: { type: "busy" },
          },
        },
      })
      client.emit({
        directory,
        payload: {
          id: "evt_question",
          type: "question.asked",
          properties: {
            id: "que_unseen",
            sessionID: "ses_unseen",
            questions: [],
          },
        },
      })
      client.sdk.flushEvents()
      expect(client.sync.data.session_status.ses_unseen).toEqual({ type: "busy" })
      expect(client.sync.data.question.ses_unseen?.[0].id).toBe("que_unseen")
      expect(client.sdk.interest.owns("ses_unseen")).toBe(false)
    })
  } finally {
    clients.forEach((client) => client.app.renderer.destroy())
    if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
    if (previous !== undefined) process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = previous
  }
})

test("legacy hydration retains live metadata, todos, diffs, part updates and removals over an older snapshot", async () => {
  const previous = process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
  process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = "1"
  const response = Promise.withResolvers<Response>()
  let requested = false
  const session = {
    id: "ses_legacy",
    slug: "legacy",
    title: "Legacy",
    directory,
    projectID: "proj_test",
    version: "test",
    time: { created: 0, updated: 0 },
  }
  const client = await mount((url) => {
    if (url.pathname === "/session/ses_legacy") return json(session)
    if (url.pathname === "/session/ses_legacy/message") {
      requested = true
      return response.promise
    }
    if (url.pathname === "/session/ses_legacy/todo" || url.pathname === "/session/ses_legacy/diff") return json([])
  })
  try {
    client.route.navigate({ type: "session", sessionID: "ses_legacy" })
    const hydration = client.sync.session.sync("ses_legacy")
    await wait(() => requested)
    const part = {
      id: "prt_live",
      sessionID: "ses_legacy",
      messageID: "msg_live",
      type: "text",
      text: "fresh",
    } as const
    client.emit({
      directory,
      payload: {
        id: "evt_part",
        type: "message.part.updated",
        properties: { sessionID: part.sessionID, part, time: 1 },
      },
    })
    client.emit({
      directory,
      payload: {
        id: "evt_removed",
        type: "message.removed",
        properties: { sessionID: "ses_legacy", messageID: "msg_removed" },
      },
    })
    client.emit({
      directory,
      payload: {
        id: "evt_metadata",
        type: "session.updated",
        properties: {
          sessionID: session.id,
          info: { ...session, title: "Live title", time: { created: 0, updated: 2 } },
        },
      },
    })
    const todos = [{ content: "Live todo", priority: "high", status: "in_progress" }]
    const diff = [{ file: "live.ts", before: "old", after: "new", additions: 1, deletions: 1 }]
    client.emit({
      directory,
      payload: { id: "evt_todo", type: "todo.updated", properties: { sessionID: session.id, todos } },
    })
    client.emit({
      directory,
      payload: { id: "evt_diff", type: "session.diff", properties: { sessionID: session.id, diff } },
    })
    response.resolve(
      json([
        {
          info: { id: "msg_live", sessionID: "ses_legacy", role: "user", time: { created: 0 } },
          parts: [{ ...part, text: "stale" }],
        },
        { info: { id: "msg_removed", sessionID: "ses_legacy", role: "user", time: { created: 1 } }, parts: [] },
      ]),
    )
    await hydration
    expect(client.sync.data.message.ses_legacy?.map((message) => message.id)).toEqual(["msg_live"])
    expect(client.sync.data.part.msg_live?.map((part) => (part.type === "text" ? part.text : undefined))).toEqual([
      "fresh",
    ])
    expect(client.sync.session.get(session.id)?.title).toBe("Live title")
    expect(client.sync.data.todo[session.id]).toEqual(todos)
    expect(client.sync.data.session_diff[session.id]).toEqual(diff)
    client.route.navigate({ type: "session", sessionID: "ses_other" })
    expect(client.sync.data.message.ses_legacy).toBeUndefined()
    expect(client.sync.data.part.msg_live).toBeUndefined()
  } finally {
    client.app.renderer.destroy()
    if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
    if (previous !== undefined) process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = previous
  }
})

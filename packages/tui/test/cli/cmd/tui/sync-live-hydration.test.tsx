/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

const sessionID = "ses_hydration_race"
const messageID = "msg_hydration_race"
const partID = "prt_hydration_race"
const session = {
  id: sessionID,
  title: "race",
  time: { created: 0, updated: 0 },
  version: "1.15.13",
  directory: "/tmp/opencode/packages/opencode",
}
const assistant = {
  id: messageID,
  sessionID,
  role: "assistant" as const,
  agent: "build",
  modelID: "model",
  providerID: "test",
  mode: "build",
  parentID: "msg_user",
  path: { cwd: session.directory, root: session.directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, completed: 2 },
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

test("history hydrates before sidebar details and reuses resolved session metadata", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const todo = Promise.withResolvers<Response>()
  const diff = Promise.withResolvers<Response>()
  let reads = 0
  const { app, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) {
      reads++
      return json(session)
    }
    if (url.pathname === `/session/${sessionID}/message`)
      return json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "history" }] }])
    if (url.pathname === `/session/${sessionID}/todo`) return todo.promise
    if (url.pathname === `/session/${sessionID}/diff`) return diff.promise
  }, tmp.path)

  try {
    let settled = false
    const hydrate = sync.session.sync(sessionID, { ...session, projectID: "proj_test", slug: "race" }).then(() => {
      settled = true
    })
    await wait(() => sync.data.message[sessionID]?.length === 1)
    expect(sync.session.get(sessionID)?.title).toBe("race")
    expect(sync.data.part[messageID][0]).toMatchObject({ text: "history" })
    expect(reads).toBe(0)
    expect(settled).toBe(false)

    todo.resolve(json([{ content: "loaded", status: "pending", priority: "high" }]))
    diff.resolve(json([{ file: "file.ts", before: "", after: "text", additions: 1, deletions: 0 }]))
    await hydrate
    expect(settled).toBe(true)
    expect(sync.data.todo[sessionID][0].content).toBe("loaded")
    expect(sync.data.session_diff[sessionID][0].file).toBe("file.ts")
    await sync.session.sync(sessionID)
    expect(reads).toBe(0)
  } finally {
    todo.resolve(json([]))
    diff.resolve(json([]))
    await app.dispose()
  }
})

test("reused metadata and independently held sidebar responses preserve live updates", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const messages = Promise.withResolvers<Response>()
  const todo = Promise.withResolvers<Response>()
  const diff = Promise.withResolvers<Response>()
  const requested = new Set<string>()
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}/message`) {
      requested.add("history")
      return messages.promise
    }
    if (url.pathname === `/session/${sessionID}/todo`) {
      requested.add("todo")
      return todo.promise
    }
    if (url.pathname === `/session/${sessionID}/diff`) {
      requested.add("diff")
      return diff.promise
    }
  }, tmp.path)
  try {
    const hydrate = sync.session.sync(sessionID, { ...session, projectID: "proj_test", slug: "race" })
    await wait(() => requested.size === 3)
    emit(
      global({
        id: "evt_new_info",
        type: "session.updated",
        properties: { sessionID, info: { ...session, projectID: "proj_test", slug: "race", title: "live title" } },
      }),
    )
    emit(
      global({
        id: "evt_new_todo",
        type: "todo.updated",
        properties: { sessionID, todos: [{ content: "live todo", status: "pending", priority: "high" }] },
      }),
    )
    emit(
      global({
        id: "evt_new_diff",
        type: "session.diff",
        properties: { sessionID, diff: [{ file: "live.ts", additions: 1, deletions: 0 }] },
      }),
    )
    await wait(() => sync.session.get(sessionID)?.title === "live title")
    messages.resolve(json([{ info: assistant, parts: [] }]))
    await wait(() => sync.data.message[sessionID]?.length === 1)
    expect(sync.session.get(sessionID)?.title).toBe("live title")
    todo.resolve(json([{ content: "old todo", status: "pending", priority: "high" }]))
    diff.resolve(json([{ file: "old.ts", before: "", after: "old", additions: 1, deletions: 0 }]))
    await hydrate
    expect(sync.data.todo[sessionID]?.[0]?.content).toBe("live todo")
    expect(sync.data.session_diff[sessionID]?.[0]?.file).toBe("live.ts")
  } finally {
    messages.resolve(json([]))
    todo.resolve(json([]))
    diff.resolve(json([]))
    await app.dispose()
  }
})

test("live messages use creation time with an ID tie-break", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)
  const messages = [
    { ...assistant, id: "msg_a", time: { created: 30, completed: 31 } },
    { ...assistant, id: "msg_z", time: { created: 10, completed: 11 } },
    { ...assistant, id: "msg_m", time: { created: 20, completed: 21 } },
    { ...assistant, id: "msg_b", time: { created: 20, completed: 21 } },
  ]

  try {
    for (const info of messages) {
      emit(global({ id: `evt_${info.id}`, type: "message.updated", properties: { sessionID, info } }))
    }
    await wait(() => sync.data.message[sessionID]?.length === messages.length)

    expect(sync.data.message[sessionID].map((message) => message.id)).toEqual(["msg_z", "msg_b", "msg_m", "msg_a"])
  } finally {
    await app.dispose()
  }
})

test("stale session hydration does not overwrite live message parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    emit(
      global({
        id: "evt_part",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 2,
          part: { id: partID, sessionID, messageID, type: "text", text: "visible live content" },
        },
      }),
    )
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text")

    resolveMessages(
      json([
        {
          info: assistant,
          parts: [{ id: partID, sessionID, messageID, type: "text", text: "" }],
        },
      ]),
    )
    await hydrate

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "visible live content" })
  } finally {
    await app.dispose()
  }
})

test("orphan live deltas do not suppress hydrated parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(
      global({
        id: "evt_delta",
        type: "message.part.delta",
        properties: { sessionID, messageID, partID, field: "text", delta: "ignored until part exists" },
      }),
    )
    resolveMessages(
      json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "hydrated" }] }]),
    )
    await hydrate

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "hydrated" })
  } finally {
    await app.dispose()
  }
})

test("hydration does not clear text streamed before it starts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    emit(
      global({
        id: "evt_part",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 1,
          part: { id: partID, sessionID, messageID, type: "text", text: "" },
        },
      }),
    )
    emit(
      global({
        id: "evt_delta",
        type: "message.part.delta",
        properties: { sessionID, messageID, partID, field: "text", delta: "visible streamed content" },
      }),
    )
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text" && sync.data.part[messageID][0].text !== "")
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    resolveMessages(json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "" }] }]))
    await hydrate

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "visible streamed content" })
  } finally {
    await app.dispose()
  }
})

test("live messages merged during hydration retain the 100 message window", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    const live = { ...assistant, id: "msg_z_live" }
    emit(global({ id: "evt_live", type: "message.updated", properties: { sessionID, info: live } }))
    await wait(() => sync.data.message[sessionID]?.some((message) => message.id === live.id) ?? false)
    resolveMessages(
      json(
        Array.from({ length: 100 }, (_, index) => {
          const id = `msg_${String(index).padStart(3, "0")}`
          return {
            info: { ...assistant, id },
            parts: [{ id: `prt_${id}`, sessionID, messageID: id, type: "text", text: id }],
          }
        }),
      ),
    )
    await hydrate

    expect(sync.data.message[sessionID]).toHaveLength(100)
    expect(sync.data.message[sessionID].at(-1)?.id).toBe(live.id)
    expect(sync.data.message[sessionID].some((message) => message.id === "msg_000")).toBe(false)
    expect(sync.data.part.msg_000).toBeUndefined()
  } finally {
    await app.dispose()
  }
})

test("a message removed during hydration does not regain stale parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    await wait(() => sync.data.message[sessionID]?.length === 1)
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(global({ id: "evt_removed", type: "message.removed", properties: { sessionID, messageID } }))
    await wait(() => sync.data.message[sessionID]?.length === 0)
    resolveMessages(
      json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "stale" }] }]),
    )
    await hydrate

    expect(sync.data.message[sessionID]).toEqual([])
    expect(sync.data.part[messageID]).toBeUndefined()
  } finally {
    await app.dispose()
  }
})

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { GlobalEvent, PermissionRequest, QuestionRequest, SessionStatus } from "@opencode-ai/sdk/v2"
import { ArgsProvider } from "../../../src/context/args"
import { KVProvider } from "../../../src/context/kv"
import { SDKProvider, useSDK } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { DataProvider, useData } from "../../../src/context/data"
import { ProjectProvider } from "../../../src/context/project"
import { PermissionProvider, usePermission } from "../../../src/context/permission"
import { ExitProvider } from "../../../src/context/exit"
import { useRoute } from "../../../src/context/route"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createFetch, directory, json, type FetchHandler } from "../../fixture/tui-sdk"
import { wait } from "../cmd/tui/sync-fixture"
import { tmpdir } from "../../fixture/fixture"

const sessionID = "ses_recovery"
const session = {
  id: sessionID,
  slug: "recovery",
  title: "recovery",
  directory,
  projectID: "proj_test",
  version: "test",
  time: { created: 0, updated: 0 },
}
const user = (id: string) => ({ id, sessionID, role: "user", time: { created: 0 } })
const v2user = (id: string) => ({ id, type: "user", text: id, time: { created: 0 } })

async function mountRecovery(override?: FetchHandler, connected = true, headers?: RequestInit["headers"]) {
  const streams: {
    url: URL
    send: (payload: GlobalEvent["payload"], location?: string, workspace?: string) => void
    end: () => void
    closed: boolean
  }[] = []
  const requests: Request[] = []
  const removed = new Set<string>()
  const fallback = createFetch((url, request) => {
    if (request)
      requests.push(new Request(request.url, { method: request.method, headers: new Headers(request.headers) }))
    if (url.pathname === "/global/event") {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const stream = {
              url,
              closed: false,
              send(payload: GlobalEvent["payload"], location = directory, workspace?: string) {
                if (stream.closed) return
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify({ directory: location, workspace, payload })}\n\n`),
                )
              },
              end() {
                if (stream.closed) return
                stream.closed = true
                controller.close()
              },
            }
            streams.push(stream)
            request?.signal.addEventListener("abort", () => stream.end(), { once: true })
            if (connected)
              stream.send({ id: `evt_connected_${streams.length}`, type: "server.connected", properties: {} })
          },
          cancel() {
            // Bun's HTTP server invokes cancellation when the client replaces SSE.
            streams.at(-1)!.closed = true
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    const scoped = url.pathname.match(/^\/api\/session\/([^/]+)\/(permission|question)(?:\/|$)/)
    // Production SessionLocationMiddleware rejects these reads before their
    // handlers can return empty request arrays when the Session row is gone.
    if (scoped && removed.has(scoped[1]!))
      return json({ _tag: "SessionNotFoundError", sessionID: scoped[1], message: "Session not found" }, { status: 404 })
    const response = override?.(url, request)
    if (response) return response
    if (["/permission", "/question"].includes(url.pathname)) return json([])
    if (["/api/permission/request", "/api/question/request"].includes(url.pathname)) return json({ data: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)$/.test(url.pathname)) return json({ data: [] })
    if (url.pathname === "/project/proj_test/directories") return json([])
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) return json([])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ sequence: 0, cursor: {}, data: [] })
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: (request) => fallback.fetch(request),
  })
  const tmp = await tmpdir()
  const disposals = new Set<Promise<void>>()
  let sdk!: ReturnType<typeof useSDK>
  let sync!: ReturnType<typeof useSync>
  let data!: ReturnType<typeof useData>
  let route!: ReturnType<typeof useRoute>
  let permission!: ReturnType<typeof usePermission>
  function Probe() {
    sdk = useSDK()
    sync = useSync()
    data = useData()
    route = useRoute()
    permission = usePermission()
    return <box />
  }
  const app = await testRender(() => (
    <TestTuiContexts paths={{ state: tmp.path }} onDispose={(done) => disposals.add(done)}>
      <ArgsProvider>
        <KVProvider>
          <SDKProvider url={server.url.toString()} directory={directory} headers={headers}>
            <PermissionProvider>
              <ProjectProvider>
                <ExitProvider exit={() => {}}>
                  <SyncProvider>
                    <DataProvider>
                      <Probe />
                    </DataProvider>
                  </SyncProvider>
                </ExitProvider>
              </ProjectProvider>
            </PermissionProvider>
          </SDKProvider>
        </KVProvider>
      </ArgsProvider>
    </TestTuiContexts>
  ))
  await wait(() => streams.length > 0 && sdk !== undefined)
  if (connected) await sdk.eventsReady()
  return {
    sdk,
    sync,
    data,
    route,
    permission,
    streams,
    requests,
    deleteSession(sessionID: string) {
      removed.add(sessionID)
    },
    async dispose() {
      app.renderer.destroy()
      streams.forEach((stream) => stream.end())
      await server.stop(true)
      await Promise.all(disposals)
      await tmp[Symbol.asyncDispose]()
    },
  }
}

for (const mode of ["default EOF", "selective EOF", "selective interest replacement"]) {
  test(`SSE reconciles missed approvals, questions and status before dispatch (${mode})`, async () => {
    const selective = mode !== "default EOF"
    const previous = process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
    process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = selective ? "1" : "0"
    let permissions: PermissionRequest[] = []
    let questions: QuestionRequest[] = []
    let status: Record<string, SessionStatus> = {}
    let v2permissions: unknown[] = []
    let v2questions: unknown[] = []
    const held = Promise.withResolvers<void>()
    let recovering = false
    let blocked = false
    let post = false
    const client = await mountRecovery((url, request) => {
      if (url.pathname === "/permission") {
        if (!recovering) return json(permissions)
        blocked = true
        return held.promise.then(() => json(permissions))
      }
      if (url.pathname === "/question") return json(questions)
      if (url.pathname === "/session/status") return json(status)
      if (url.pathname === "/api/permission/request" || url.pathname.endsWith(`/${sessionID}/permission`))
        return json({ data: v2permissions })
      if (url.pathname === "/api/question/request" || url.pathname.endsWith(`/${sessionID}/question`))
        return json({ data: v2questions })
      if (url.pathname === `/api/session/${sessionID}/prompt` && request?.method === "POST") {
        post = true
        expect(client.sync.data.permission[sessionID]?.map((item) => item.id)).toEqual(["per_gap"])
        expect(client.sync.data.question[sessionID]?.map((item) => item.id)).toEqual(["que_gap"])
        expect(client.sync.data.session_status[sessionID]).toEqual({ type: "busy" })
        expect(client.data.session.permission.list(sessionID)?.map((item) => item.id)).toEqual(["per_v2_gap"])
        return json({})
      }
    })
    try {
      client.route.navigate({ type: "session", sessionID })
      client.sdk.adoptSession(sessionID)
      await client.sdk.eventsReady()
      const stream = client.streams.at(-1)!
      stream.send({
        id: "evt_old",
        type: "permission.asked",
        properties: { id: "per_old", sessionID, permission: "bash", patterns: [], always: [], metadata: {} },
      })
      stream.send({ id: "evt_oldq", type: "question.asked", properties: { id: "que_old", sessionID, questions: [] } })
      stream.send({
        id: "evt_oldv2",
        type: "permission.v2.asked",
        properties: { id: "per_v2_old", sessionID, action: "bash", resources: [] },
      })
      await wait(() => client.sync.data.permission[sessionID]?.[0]?.id === "per_old")
      const epoch = client.sdk.connectionEpoch
      if (mode === "selective interest replacement") client.route.navigate({ type: "session", sessionID: "ses_other" })
      if (mode !== "selective interest replacement") stream.end()
      await wait(() => client.sdk.connectionEpoch !== epoch)
      permissions = [{ id: "per_gap", sessionID, permission: "bash", patterns: [], always: [], metadata: {} }]
      questions = [{ id: "que_gap", sessionID, questions: [] }]
      status = { [sessionID]: { type: "busy" } }
      v2permissions = [{ id: "per_v2_gap", sessionID, action: "bash", resources: [] }]
      v2questions = [{ id: "que_v2_gap", sessionID, questions: [] }]
      recovering = true
      const submission = client.sdk.client.v2.session.prompt(
        { sessionID, prompt: { text: "hello" } },
        { throwOnError: true },
      )
      await wait(() => blocked)
      expect(post).toBe(false)
      held.resolve()
      await submission
      expect(post).toBe(true)
      expect(client.data.session.question.list(sessionID)?.map((item) => item.id)).toEqual(["que_v2_gap"])
      expect(client.sdk.interest.owns(sessionID)).toBe(true)
      expect(client.streams.every((item) => !item.url.searchParams.has("delivery"))).toBe(true)
      expect(client.streams.at(-1)!.url.searchParams.has("sessions")).toBe(selective)
    } finally {
      held.resolve()
      await client.dispose()
      if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
      if (previous !== undefined) process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = previous
    }
  })
}

test("a request aborted before SSE readiness rejects immediately without a POST", async () => {
  const previous = process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
  process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = "1"
  const client = await mountRecovery(undefined, false)
  try {
    const abort = new AbortController()
    const submission = client.sdk.client.v2.session.prompt(
      { sessionID, prompt: { text: "cancel" } },
      { signal: abort.signal, throwOnError: true },
    )
    const failure = submission.catch((error) => error)
    await wait(() => client.sdk.interest.owns(sessionID))
    abort.abort(new Error("request canceled"))
    expect((await failure).message).toBe("request canceled")
    expect(client.requests.some((request) => request.method === "POST")).toBe(false)
    client.route.navigate({ type: "session", sessionID })
    await wait(() => client.streams.at(-1)!.url.searchParams.get("sessions") === sessionID)
    client.streams.at(-1)!.send({ id: "evt_ready", type: "server.connected", properties: {} })
    await client.sdk.eventsReady()
    expect(client.requests.some((request) => request.method === "POST")).toBe(false)
  } finally {
    await client.dispose()
    if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
    if (previous !== undefined) process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = previous
  }
})

for (const selective of [false, true]) {
  for (const observed of [false, true]) {
    test(`Session deletion ${observed ? "observed before EOF" : "during an SSE outage"} prunes caches and releases survivor submissions (${selective ? "selective" : "default"})`, async () => {
      const previous = process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
      process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = selective ? "1" : "0"
      const deletedID = "ses_deleted_recovery"
      const deleted = { ...session, id: deletedID, title: "deleted" }
      let missing = false
      let staleReads = 0
      let posts = 0
      const client = await mountRecovery((url, request) => {
        if (url.pathname === `/session/${deletedID}`) {
          if (!missing) return json(deleted)
          staleReads++
          return json({ name: "NotFoundError", data: { message: "Session not found" } }, { status: 404 })
        }
        if (url.pathname === `/session/${deletedID}/message`)
          return json([
            {
              info: { ...user("msg_deleted"), sessionID: deletedID },
              parts: [{ id: "prt_deleted", sessionID: deletedID, messageID: "msg_deleted", type: "text", text: "old" }],
            },
          ])
        if (url.pathname === `/session/${deletedID}/todo`)
          return json([{ content: "deleted todo", status: "pending", priority: "high" }])
        if (url.pathname === `/session/${deletedID}/diff`)
          return json([{ file: "deleted.ts", additions: 1, deletions: 0 }])
        if (url.pathname === `/api/session/${deletedID}/message`)
          return missing
            ? json(
                { _tag: "SessionNotFoundError", sessionID: deletedID, message: "Session not found" },
                { status: 404 },
              )
            : json({ sequence: 1, cursor: {}, data: [v2user("msg_deleted_v2")] })
        if (url.pathname === `/api/session/${sessionID}/prompt` && request?.method === "POST") {
          posts++
          return json({})
        }
      })
      try {
        client.route.navigate({ type: "session", sessionID: deletedID })
        client.sdk.adoptSession(deletedID)
        await client.sdk.eventsReady()
        await client.sync.session.sync(deletedID)
        await client.data.session.message.refresh(deletedID)
        expect(client.sync.data.part.msg_deleted).toHaveLength(1)
        expect(client.sync.data.todo[deletedID]).toHaveLength(1)
        expect(client.sync.data.session_diff[deletedID]).toHaveLength(1)
        expect(client.data.session.message.list(deletedID)).toHaveLength(1)
        if (observed) {
          for (const title of ["live", "buffered"]) {
            client.streams.at(-1)!.send({
              id: `evt_update_${title}`,
              type: "session.updated",
              properties: { sessionID: deletedID, info: { ...deleted, title } },
            })
          }
          client.streams
            .at(-1)!
            .send({ id: "evt_deleted", type: "session.deleted", properties: { sessionID: deletedID, info: deleted } })
          await wait(() => client.sync.session.get(deletedID) === undefined)
        }
        missing = true
        client.deleteSession(deletedID)
        const epoch = client.sdk.connectionEpoch
        client.streams.at(-1)!.end()
        await wait(() => client.sdk.connectionEpoch !== epoch)
        const submission = client.sdk.client.v2.session
          .prompt({ sessionID, prompt: { text: "survive deletion" } }, { throwOnError: true })
          .then(
            () => undefined,
            (error: unknown) => error,
          )
        await wait(() => posts === 1, 5000)
        expect(await submission).toBeUndefined()
        expect(client.sync.session.get(deletedID)).toBeUndefined()
        expect(client.sync.data.message[deletedID]).toBeUndefined()
        expect(client.sync.data.part.msg_deleted).toBeUndefined()
        expect(client.sync.data.todo[deletedID]).toBeUndefined()
        expect(client.sync.data.session_diff[deletedID]).toBeUndefined()
        expect(client.data.session.message.list(deletedID)).toBeUndefined()
        expect(client.sdk.interest.owns(deletedID)).toBe(false)
        expect(client.sdk.interest.query().split(",")).not.toContain(deletedID)
        expect(staleReads).toBe(observed ? 0 : 1)
        const reads = client.requests.filter((request) => new URL(request.url).pathname.includes(deletedID)).length
        const recoveredEpoch = client.sdk.connectionEpoch
        client.streams.at(-1)!.end()
        await wait(() => client.sdk.connectionEpoch !== recoveredEpoch)
        await client.sdk.eventsReady()
        expect(client.requests.filter((request) => new URL(request.url).pathname.includes(deletedID))).toHaveLength(
          reads,
        )
      } finally {
        await client.dispose()
        if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
        if (previous !== undefined) process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = previous
      }
    })
  }
}

for (const controlled of [false, true]) {
  test(`request-only ${controlled ? "controlled" : "view-only"} deleted Sessions cannot poison recovery`, async () => {
    const previous = process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
    process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = "0"
    const deletedID = "ses_deleted_requests"
    let posts = 0
    const client = await mountRecovery((url, request) => {
      if (url.pathname === `/api/session/${sessionID}/prompt` && request?.method === "POST") {
        posts++
        return json({})
      }
    })
    try {
      if (controlled) client.sdk.adoptSession(deletedID)
      const stream = client.streams.at(-1)!
      stream.send({
        id: "evt_request_only_permission",
        type: "permission.v2.asked",
        properties: { id: "per_request_only", sessionID: deletedID, action: "bash", resources: [] },
      })
      stream.send({
        id: "evt_request_only_question",
        type: "question.v2.asked",
        properties: { id: "que_request_only", sessionID: deletedID, questions: [] },
      })
      await wait(() => client.data.session.question.list(deletedID)?.[0]?.id === "que_request_only")
      expect(client.data.session.permission.list(deletedID)?.[0]?.id).toBe("per_request_only")
      expect(client.sync.session.get(deletedID)).toBeUndefined()
      expect(client.sync.data.message[deletedID]).toBeUndefined()
      expect(client.data.session.message.list(deletedID)).toBeUndefined()
      expect(client.sdk.interest.owns(deletedID)).toBe(controlled)
      client.deleteSession(deletedID)
      if (controlled) client.permission.set("auto")
      const epoch = client.sdk.connectionEpoch
      const connections = client.streams.length
      stream.end()
      await wait(() => client.sdk.connectionEpoch !== epoch)
      const submission = client.sdk.client.v2.session
        .prompt({ sessionID, prompt: { text: "survive request-only deletion" } }, { throwOnError: true })
        .then(
          () => undefined,
          (error: unknown) => error,
        )
      await wait(() => posts === 1, 5000)
      expect(await submission).toBeUndefined()
      expect(client.sdk.connectionEpoch).toBe(epoch + 1)
      expect(client.streams).toHaveLength(connections + 1)
      expect(client.data.session.permission.list(deletedID)).toBeUndefined()
      expect(client.data.session.question.list(deletedID)).toBeUndefined()
      expect(client.sdk.interest.owns(deletedID)).toBe(false)
      const reads = client.requests.filter((request) => new URL(request.url).pathname.includes(deletedID)).length
      expect(reads).toBeGreaterThanOrEqual(2)
      expect(
        client.requests.some((request) => new URL(request.url).pathname === `/api/session/${deletedID}/message`),
      ).toBe(false)
      const recoveredEpoch = client.sdk.connectionEpoch
      client.streams.at(-1)!.end()
      await wait(() => client.sdk.connectionEpoch !== recoveredEpoch)
      await client.sdk.eventsReady()
      expect(client.requests.filter((request) => new URL(request.url).pathname.includes(deletedID))).toHaveLength(reads)
    } finally {
      await client.dispose()
      if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
      if (previous !== undefined) process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = previous
    }
  })
}

for (const failure of ["503", "untyped 404", "foreign Session 404"]) {
  test(`request-only recovery retries ${failure} without deleting the target or dispatching early`, async () => {
    const previous = process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
    process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = "0"
    const target = "ses_request_retry"
    const held = Promise.withResolvers<void>()
    let gap = false
    let reads = 0
    let blocked = false
    let posts = 0
    let failedEpoch = 0
    const client = await mountRecovery((url, request) => {
      if (gap && url.pathname === `/api/session/${target}/permission`) {
        reads++
        if (reads === 1) {
          failedEpoch = client.sdk.connectionEpoch
          return json(
            failure === "foreign Session 404"
              ? { _tag: "SessionNotFoundError", sessionID: "ses_someone_else", message: "Session not found" }
              : { error: "temporarily unavailable" },
            { status: failure === "503" ? 503 : 404 },
          )
        }
        blocked = true
        return held.promise.then(() =>
          json({ data: [{ id: "per_request_fresh", sessionID: target, action: "bash", resources: [] }] }),
        )
      }
      if (url.pathname === `/api/session/${sessionID}/prompt` && request?.method === "POST") {
        posts++
        return json({})
      }
    })
    try {
      client.streams.at(-1)!.send({
        id: "evt_request_retry",
        type: "permission.v2.asked",
        properties: { id: "per_request_cached", sessionID: target, action: "bash", resources: [] },
      })
      await wait(() => client.data.session.permission.list(target)?.length === 1)
      gap = true
      const epoch = client.sdk.connectionEpoch
      client.streams.at(-1)!.end()
      await wait(() => client.sdk.connectionEpoch !== epoch)
      const submission = client.sdk.client.v2.session
        .prompt({ sessionID, prompt: { text: "wait for request recovery" } }, { throwOnError: true })
        .then(
          () => undefined,
          (error: unknown) => error,
        )
      await wait(() => blocked, 5000)
      expect(client.sdk.connectionEpoch).toBeGreaterThan(failedEpoch)
      expect(client.data.session.permission.list(target)?.[0]?.id).toBe("per_request_cached")
      expect(posts).toBe(0)
      held.resolve()
      expect(await submission).toBeUndefined()
      expect(posts).toBe(1)
      expect(client.data.session.permission.list(target)?.[0]?.id).toBe("per_request_fresh")
      expect(reads).toBe(2)
    } finally {
      held.resolve()
      await client.dispose()
      if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
      if (previous !== undefined) process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = previous
    }
  })
}

test("held recovery snapshots cannot restore deleted requests or status in the same SSE epoch", async () => {
  const previous = process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
  process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = "0"
  const deletedID = "ses_deleted_held_requests"
  const held = Promise.withResolvers<void>()
  const blocked = new Set<string>()
  let holding = false
  let posts = 0
  const legacyPermission = (id: string) => ({
    id: `per_${id}`,
    sessionID: id,
    permission: "bash",
    patterns: [],
    always: [],
    metadata: {},
  })
  const legacyQuestion = (id: string) => ({ id: `que_${id}`, sessionID: id, questions: [] })
  const v2permission = (id: string) => ({ id: `per_v2_${id}`, sessionID: id, action: "bash", resources: [] })
  const v2question = (id: string) => ({ id: `que_v2_${id}`, sessionID: id, questions: [] })
  const client = await mountRecovery((url, request) => {
    if (url.pathname === `/api/session/${sessionID}/prompt` && request?.method === "POST") {
      posts++
      return json({})
    }
    if (!holding) return
    const response = (() => {
      if (url.pathname === "/permission") return json([legacyPermission(deletedID), legacyPermission(sessionID)])
      if (url.pathname === "/question") return json([legacyQuestion(deletedID), legacyQuestion(sessionID)])
      if (url.pathname === "/session/status")
        return json({ [deletedID]: { type: "busy" }, [sessionID]: { type: "busy" } })
      if (url.pathname === "/api/permission/request")
        return json({ data: [v2permission(deletedID), v2permission(sessionID)] })
      if (url.pathname === "/api/question/request")
        return json({ data: [v2question(deletedID), v2question(sessionID)] })
      if (url.pathname === `/api/session/${deletedID}/permission`) return json({ data: [v2permission(deletedID)] })
      if (url.pathname === `/api/session/${deletedID}/question`) return json({ data: [v2question(deletedID)] })
    })()
    if (!response) return
    blocked.add(url.pathname)
    return held.promise.then(() => response)
  })
  try {
    const stream = client.streams.at(-1)!
    stream.send({ id: "evt_held_legacy_permission", type: "permission.asked", properties: legacyPermission(deletedID) })
    stream.send({ id: "evt_held_legacy_question", type: "question.asked", properties: legacyQuestion(deletedID) })
    stream.send({ id: "evt_held_v2_permission", type: "permission.v2.asked", properties: v2permission(deletedID) })
    stream.send({ id: "evt_held_v2_question", type: "question.v2.asked", properties: v2question(deletedID) })
    await wait(() => client.data.session.question.list(deletedID)?.length === 1)
    holding = true
    const epoch = client.sdk.connectionEpoch
    stream.end()
    await wait(() => client.sdk.connectionEpoch !== epoch)
    const submission = client.sdk.client.v2.session
      .prompt({ sessionID, prompt: { text: "survive held deletion snapshots" } }, { throwOnError: true })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    await wait(() => blocked.size === 7)
    expect(posts).toBe(0)
    const recoveryEpoch = client.sdk.connectionEpoch
    client.deleteSession(deletedID)
    client.streams.at(-1)!.send({
      id: "evt_deleted_while_held",
      type: "session.deleted",
      properties: { sessionID: deletedID, info: { ...session, id: deletedID } },
    })
    await wait(() => client.data.session.question.list(deletedID) === undefined)
    expect(client.sdk.connectionEpoch).toBe(recoveryEpoch)
    holding = false
    held.resolve()
    expect(await submission).toBeUndefined()
    expect(posts).toBe(1)
    expect(client.sdk.connectionEpoch).toBe(recoveryEpoch)
    expect(client.sync.data.permission[deletedID]).toBeUndefined()
    expect(client.sync.data.question[deletedID]).toBeUndefined()
    expect(client.sync.data.session_status[deletedID]).toBeUndefined()
    expect(client.data.session.permission.list(deletedID)).toBeUndefined()
    expect(client.data.session.question.list(deletedID)).toBeUndefined()
    expect(client.sync.data.permission[sessionID]?.[0]?.id).toBe(`per_${sessionID}`)
    expect(client.sync.data.question[sessionID]?.[0]?.id).toBe(`que_${sessionID}`)
    expect(client.sync.data.session_status[sessionID]).toEqual({ type: "busy" })
    expect(client.data.session.permission.list(sessionID)?.[0]?.id).toBe(`per_v2_${sessionID}`)
    expect(client.data.session.question.list(sessionID)?.[0]?.id).toBe(`que_v2_${sessionID}`)
    const reads = client.requests.filter((request) => new URL(request.url).pathname.includes(deletedID)).length
    client.streams.at(-1)!.end()
    await wait(() => client.sdk.connectionEpoch !== recoveryEpoch)
    await client.sdk.eventsReady()
    expect(client.requests.filter((request) => new URL(request.url).pathname.includes(deletedID))).toHaveLength(reads)
  } finally {
    held.resolve()
    await client.dispose()
    if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
    if (previous !== undefined) process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = previous
  }
})

test("a deleted Session cached only in V2 cannot poison recovery", async () => {
  const previous = process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
  process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = "0"
  const deletedID = "ses_deleted_v2_only"
  let missing = false
  let reads = 0
  let posts = 0
  const client = await mountRecovery((url, request) => {
    if (url.pathname === `/api/session/${deletedID}/message`) {
      reads++
      return missing
        ? json({ _tag: "SessionNotFoundError", sessionID: deletedID, message: "Session not found" }, { status: 404 })
        : json({ sequence: 1, cursor: {}, data: [v2user("msg_v2_only")] })
    }
    if (url.pathname === `/api/session/${sessionID}/prompt` && request?.method === "POST") {
      posts++
      return json({})
    }
  })
  try {
    client.sdk.adoptSession(deletedID)
    await client.data.session.message.refresh(deletedID)
    expect(client.sync.session.get(deletedID)).toBeUndefined()
    expect(client.sync.data.message[deletedID]).toBeUndefined()
    expect(client.data.session.message.list(deletedID)).toHaveLength(1)
    missing = true
    client.deleteSession(deletedID)
    const epoch = client.sdk.connectionEpoch
    client.streams.at(-1)!.end()
    await wait(() => client.sdk.connectionEpoch !== epoch)
    const submission = client.sdk.client.v2.session
      .prompt({ sessionID, prompt: { text: "recover despite deleted V2 history" } }, { throwOnError: true })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    await wait(() => posts === 1, 5000)
    expect(await submission).toBeUndefined()
    expect(reads).toBe(2)
    expect(client.data.session.message.list(deletedID)).toBeUndefined()
    expect(client.sdk.interest.owns(deletedID)).toBe(false)
    const recoveredEpoch = client.sdk.connectionEpoch
    client.streams.at(-1)!.end()
    await wait(() => client.sdk.connectionEpoch !== recoveredEpoch)
    await client.sdk.eventsReady()
    expect(reads).toBe(2)
  } finally {
    await client.dispose()
    if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
    if (previous !== undefined) process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = previous
  }
})

for (const status of [503, 404]) {
  test(`session hydration ${status === 503 ? "503" : "untyped 404"} retries without deleting cached state or releasing submissions early`, async () => {
    const held = Promise.withResolvers<Response>()
    let gap = false
    let reads = 0
    let posted = false
    let failedEpoch = 0
    const client = await mountRecovery((url, request) => {
      if (url.pathname === `/session/${sessionID}` && gap) {
        reads++
        if (reads === 1) {
          failedEpoch = client.sdk.connectionEpoch
          return json(
            status === 503
              ? { name: "NotFoundError", data: { message: "temporarily unavailable" } }
              : { error: "route missing" },
            { status },
          )
        }
        return held.promise
      }
      if (url.pathname === `/api/session/${sessionID}/prompt` && request?.method === "POST") {
        posted = true
        return json({})
      }
    })
    try {
      client.route.navigate({ type: "session", sessionID })
      await client.sdk.eventsReady()
      await client.sync.session.sync(sessionID)
      gap = true
      const epoch = client.sdk.connectionEpoch
      client.streams.at(-1)!.end()
      await wait(() => client.sdk.connectionEpoch !== epoch)
      const submission = client.sdk.client.v2.session
        .prompt({ sessionID, prompt: { text: "wait for a valid snapshot" } }, { throwOnError: true })
        .then(
          () => undefined,
          (error: unknown) => error,
        )
      await wait(() => reads === 2, 5000)
      expect(client.sdk.connectionEpoch).toBeGreaterThan(failedEpoch)
      expect(client.sync.session.get(sessionID)?.title).toBe("recovery")
      expect(client.sdk.interest.owns(sessionID)).toBe(true)
      expect(posted).toBe(false)
      held.resolve(json({ ...session, title: "fresh" }))
      expect(await submission).toBeUndefined()
      expect(posted).toBe(true)
      expect(client.sync.session.get(sessionID)?.title).toBe("fresh")
    } finally {
      held.resolve(json(session))
      await client.dispose()
    }
  })
}

test("a failed recovery snapshot retries SSE and keeps submission blocked until recovery succeeds", async () => {
  const held = Promise.withResolvers<void>()
  let gap = false
  let reads = 0
  let failedEpoch = 0
  let blocked = false
  let posted = false
  const client = await mountRecovery((url, request) => {
    if (url.pathname === "/permission" && gap) {
      reads++
      if (reads === 1) {
        failedEpoch = client.sdk.connectionEpoch
        return json({ error: "snapshot unavailable" }, { status: 503 })
      }
      blocked = true
      return held.promise.then(() =>
        json([{ id: "per_retried", sessionID, permission: "bash", patterns: [], always: [], metadata: {} }]),
      )
    }
    if (url.pathname === `/api/session/${sessionID}/prompt` && request?.method === "POST") {
      posted = true
      expect(client.sync.data.permission[sessionID]?.map((item) => item.id)).toEqual(["per_retried"])
      return json({})
    }
  })
  try {
    gap = true
    const epoch = client.sdk.connectionEpoch
    client.streams.at(-1)!.end()
    await wait(() => client.sdk.connectionEpoch !== epoch)
    const submission = client.sdk.client.v2.session.prompt(
      { sessionID, prompt: { text: "after recovery" } },
      { throwOnError: true },
    )
    await wait(() => blocked)
    expect(failedEpoch).toBeGreaterThan(epoch)
    expect(client.sdk.connectionEpoch).toBeGreaterThan(failedEpoch)
    expect(client.streams.length).toBeGreaterThanOrEqual(3)
    expect(posted).toBe(false)
    held.resolve()
    await submission
    expect(posted).toBe(true)
  } finally {
    held.resolve()
    await client.dispose()
  }
})

test("recovered approvals retain view-only versus controller automatic-approval authority", async () => {
  const previous = process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
  process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = "1"
  let gap = false
  const replies: string[][] = [[], []]
  const clients = await Promise.all(
    replies.map(async (calls) => {
      const client = await mountRecovery((url, request) => {
        if (url.pathname === "/permission")
          return json(
            gap ? [{ id: "per_auto", sessionID, permission: "bash", patterns: [], always: [], metadata: {} }] : [],
          )
        if (url.pathname === "/api/permission/request" || url.pathname === `/api/session/${sessionID}/permission`)
          return json({ data: gap ? [{ id: "per_auto_v2", sessionID, action: "bash", resources: [] }] : [] })
        if (request?.method !== "POST" || !url.pathname.endsWith("/reply")) return
        calls.push(url.pathname)
        const v2 = url.pathname.startsWith("/api/")
        client.streams.at(-1)!.send(
          v2
            ? {
                id: "evt_auto_v2",
                type: "permission.v2.replied",
                properties: { sessionID, requestID: "per_auto_v2", reply: "once" },
              }
            : {
                id: "evt_auto",
                type: "permission.replied",
                properties: { sessionID, requestID: "per_auto", reply: "once" },
              },
        )
        return v2 ? new Response(null, { status: 204 }) : json(true)
      })
      return client
    }),
  )
  try {
    for (const client of clients) {
      client.permission.set("auto")
      client.route.navigate({ type: "session", sessionID })
    }
    clients[0].sdk.adoptSession(sessionID)
    await Promise.all(clients.map((client) => client.sdk.eventsReady()))
    gap = true
    for (const client of clients) {
      const epoch = client.sdk.connectionEpoch
      client.streams.at(-1)!.end()
      await wait(() => client.sdk.connectionEpoch !== epoch)
    }
    await Promise.all(clients.map((client) => client.sdk.eventsReady()))
    expect(replies[0].toSorted()).toEqual([
      `/api/session/${sessionID}/permission/per_auto_v2/reply`,
      "/permission/per_auto/reply",
    ])
    expect(replies[1]).toEqual([])
    expect(clients[1].sdk.interest.owns(sessionID)).toBe(false)
    expect(clients[1].sync.data.permission[sessionID]?.[0]?.id).toBe("per_auto")
    expect(clients[1].data.session.permission.list(sessionID)?.[0]?.id).toBe("per_auto_v2")
  } finally {
    await Promise.all(clients.map((client) => client.dispose()))
    if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
    if (previous !== undefined) process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = previous
  }
})

test("live request replies, new requests and status win over held reconnect snapshots", async () => {
  const previous = process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
  process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = "1"
  const held = Promise.withResolvers<void>()
  let gap = false
  let blocked = false
  const client = await mountRecovery((url) => {
    if (!gap) return
    if (url.pathname === "/session/status") return json({ [sessionID]: { type: "busy" } })
    const response =
      url.pathname === "/permission"
        ? json([{ id: "per_stale", sessionID, permission: "bash", patterns: [], always: [], metadata: {} }])
        : url.pathname === "/question"
          ? json([{ id: "que_stale", sessionID, questions: [] }])
          : url.pathname === "/api/permission/request" || url.pathname === `/api/session/${sessionID}/permission`
            ? json({ data: [{ id: "per_v2_stale", sessionID, action: "bash", resources: [] }] })
            : url.pathname === "/api/question/request" || url.pathname === `/api/session/${sessionID}/question`
              ? json({ data: [{ id: "que_v2_stale", sessionID, questions: [] }] })
              : undefined
    if (!response) return
    blocked = true
    return held.promise.then(() => response)
  })
  try {
    client.route.navigate({ type: "session", sessionID })
    await client.sdk.eventsReady()
    gap = true
    const epoch = client.sdk.connectionEpoch
    client.streams.at(-1)!.end()
    await wait(() => client.sdk.connectionEpoch !== epoch)
    const recovery = client.sdk.eventsReady()
    await wait(() => blocked)
    const stream = client.streams.at(-1)!
    stream.send({
      id: "evt_replied",
      type: "permission.replied",
      properties: { sessionID, requestID: "per_stale", reply: "once" },
    })
    stream.send({ id: "evt_rejected", type: "question.rejected", properties: { sessionID, requestID: "que_stale" } })
    stream.send({
      id: "evt_live",
      type: "permission.asked",
      properties: { id: "per_live", sessionID, permission: "bash", patterns: [], always: [], metadata: {} },
    })
    stream.send({ id: "evt_liveq", type: "question.asked", properties: { id: "que_live", sessionID, questions: [] } })
    stream.send({
      id: "evt_replied_v2",
      type: "permission.v2.replied",
      properties: { sessionID, requestID: "per_v2_stale", reply: "once" },
    })
    stream.send({
      id: "evt_rejected_v2",
      type: "question.v2.rejected",
      properties: { sessionID, requestID: "que_v2_stale" },
    })
    stream.send({
      id: "evt_live_v2",
      type: "permission.v2.asked",
      properties: { id: "per_v2_live", sessionID, action: "bash", resources: [] },
    })
    stream.send({
      id: "evt_liveq_v2",
      type: "question.v2.asked",
      properties: { id: "que_v2_live", sessionID, questions: [] },
    })
    stream.send({ id: "evt_idle", type: "session.status", properties: { sessionID, status: { type: "idle" } } })
    await wait(
      () =>
        client.sync.data.session_status[sessionID]?.type === "idle" &&
        client.data.session.question.list(sessionID)?.[0]?.id === "que_v2_live",
    )
    held.resolve()
    await recovery
    expect(client.sync.data.permission[sessionID]?.map((item) => item.id)).toEqual(["per_live"])
    expect(client.sync.data.question[sessionID]?.map((item) => item.id)).toEqual(["que_live"])
    expect(client.sync.data.session_status[sessionID]).toEqual({ type: "idle" })
    expect(client.data.session.permission.list(sessionID)?.map((item) => item.id)).toEqual(["per_v2_live"])
    expect(client.data.session.question.list(sessionID)?.map((item) => item.id)).toEqual(["que_v2_live"])
  } finally {
    held.resolve()
    await client.dispose()
    if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
    if (previous !== undefined) process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = previous
  }
})

test("a held bootstrap status read cannot overwrite authoritative connection recovery", async () => {
  const held = Promise.withResolvers<Response>()
  let reads = 0
  const client = await mountRecovery((url) => {
    if (url.pathname !== "/session/status") return
    reads++
    return reads === 1 ? held.promise : json({})
  }, false)
  try {
    await wait(() => reads === 1)
    client.streams.at(-1)!.send({ id: "evt_ready", type: "server.connected", properties: {} })
    await client.sdk.eventsReady()
    expect(reads).toBe(2)
    held.resolve(json({ [sessionID]: { type: "busy" } }))
    await wait(() => client.sync.status === "complete")
    expect(client.sync.data.session_status[sessionID]).toBeUndefined()
  } finally {
    held.resolve(json({}))
    await client.dispose()
  }
})

for (const selective of [false, true]) {
  for (const v2 of [false, true]) {
    test(`a held ${v2 ? "V2" : "legacy"} hydration from the old SSE epoch cannot satisfy recovery (${selective ? "selective" : "default"})`, async () => {
      const previous = process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
      process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = selective ? "1" : "0"
      const held = Promise.withResolvers<Response>()
      let reads = 0
      const pathname = `${v2 ? "/api" : ""}/session/${sessionID}/message`
      const client = await mountRecovery((url) => {
        if (url.pathname !== pathname) return
        reads++
        if (reads === 1) return held.promise
        return json(
          v2 ? { sequence: 11, data: [v2user("msg_gap")], cursor: {} } : [{ info: user("msg_gap"), parts: [] }],
        )
      })
      try {
        client.route.navigate({ type: "session", sessionID })
        await client.sdk.eventsReady()
        const hydration = v2 ? client.data.session.message.refresh(sessionID) : client.sync.session.sync(sessionID)
        await wait(() => reads === 1)
        const oldEpoch = client.sdk.connectionEpoch
        client.streams.at(-1)!.end()
        await wait(() => client.sdk.connectionEpoch !== oldEpoch)
        await client.sdk.eventsReady()
        expect(reads).toBe(2)
        const visible = () =>
          v2
            ? client.data.session.message.list(sessionID)?.map((item) => item.id)
            : client.sync.data.message[sessionID]?.map((item) => item.id)
        expect(visible()).toEqual(["msg_gap"])
        held.resolve(
          json(v2 ? { sequence: 10, data: [v2user("msg_old")], cursor: {} } : [{ info: user("msg_old"), parts: [] }]),
        )
        await hydration
        expect(visible()).toEqual(["msg_gap"])
      } finally {
        held.resolve(json(v2 ? { sequence: 10, data: [], cursor: {} } : []))
        await client.dispose()
        if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
        if (previous !== undefined) process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = previous
      }
    })
  }
}

for (const selective of [false, true]) {
  test(`late sidebar hydration cannot overwrite recovered history or mark an old epoch synced (${selective ? "selective" : "default"})`, async () => {
    const previous = process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
    process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = selective ? "1" : "0"
    const todo = Promise.withResolvers<Response>()
    const diff = Promise.withResolvers<Response>()
    const reads = { history: 0, todo: 0, diff: 0, info: 0 }
    const client = await mountRecovery((url) => {
      if (url.pathname === `/session/${sessionID}`) {
        reads.info++
        return json({ ...session, title: "recovered" })
      }
      if (url.pathname === `/session/${sessionID}/message`) {
        reads.history++
        return json([{ info: user(reads.history === 1 ? "msg_old" : "msg_gap"), parts: [] }])
      }
      if (url.pathname === `/session/${sessionID}/todo`) {
        reads.todo++
        return reads.todo === 1 ? todo.promise : json([{ content: "new", status: "pending", priority: "high" }])
      }
      if (url.pathname === `/session/${sessionID}/diff`) {
        reads.diff++
        return reads.diff === 1
          ? diff.promise
          : json([{ file: "new.ts", before: "", after: "new", additions: 1, deletions: 0 }])
      }
    })
    try {
      client.route.navigate({ type: "session", sessionID })
      await client.sdk.eventsReady()
      const hydration = client.sync.session.sync(sessionID, session)
      await wait(() => client.sync.data.message[sessionID]?.[0]?.id === "msg_old" && reads.diff === 1)
      expect(reads.info).toBe(0)
      const epoch = client.sdk.connectionEpoch
      client.streams.at(-1)!.end()
      await wait(() => client.sdk.connectionEpoch !== epoch)
      await client.sdk.eventsReady()
      expect(client.sync.data.message[sessionID]?.map((message) => message.id)).toEqual(["msg_gap"])
      expect(client.sync.session.get(sessionID)?.title).toBe("recovered")
      expect(client.sync.data.todo[sessionID]?.[0]?.content).toBe("new")
      expect(client.sync.data.session_diff[sessionID]?.[0]?.file).toBe("new.ts")
      todo.resolve(json([{ content: "old", status: "pending", priority: "high" }]))
      diff.resolve(json([{ file: "old.ts", before: "", after: "old", additions: 1, deletions: 0 }]))
      await hydration
      expect(client.sync.data.todo[sessionID]?.[0]?.content).toBe("new")
      expect(client.sync.data.session_diff[sessionID]?.[0]?.file).toBe("new.ts")
      const historyReads = reads.history
      await client.sync.session.sync(sessionID)
      expect(reads.history).toBe(historyReads)
      expect(client.sync.data.message[sessionID]?.map((message) => message.id)).toEqual(["msg_gap"])
    } finally {
      todo.resolve(json([]))
      diff.resolve(json([]))
      await client.dispose()
      if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
      if (previous !== undefined) process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = previous
    }
  })
}

test("volatile text survives interleaved durable fragments until full-value settlement", async () => {
  const previous = process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
  process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = "1"
  const held = Promise.withResolvers<Response>()
  let reads = 0
  const assistant = {
    id: "msg_assistant",
    type: "assistant",
    agent: "build",
    model: { id: "fake", providerID: "local" },
    content: [{ type: "text", id: "txt_live", text: "" }],
    time: { created: 0 },
  }
  const client = await mountRecovery((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    reads++
    return reads === 1 ? json({ sequence: 10, cursor: {}, data: [assistant] }) : held.promise
  })
  try {
    client.route.navigate({ type: "session", sessionID })
    await client.sdk.eventsReady()
    await client.data.session.message.refresh(sessionID)
    const stream = client.streams.at(-1)!
    const delta = (text: string) =>
      stream.send({
        id: `evt_delta_${text}`,
        type: "session.next.text.delta",
        properties: { sessionID, assistantMessageID: assistant.id, textID: "txt_live", delta: text, timestamp: 1 },
      })
    delta("A")
    await wait(() => {
      const item = client.data.session.message.list(sessionID)?.[0]
      return item?.type === "assistant" && item.content[0]?.type === "text" && item.content[0].text === "A"
    })
    const hydration = client.data.session.message.refresh(sessionID)
    await wait(() => reads === 2)
    delta("+")
    stream.send({
      id: "evt_fragment",
      type: "sync",
      syncEvent: {
        id: "evt_fragment",
        aggregateID: sessionID,
        seq: 11,
        type: "session.next.reasoning.started.1",
        data: { sessionID, assistantMessageID: assistant.id, reasoningID: "reason_other", timestamp: 2 },
      },
    })
    held.resolve(
      json({
        sequence: 11,
        cursor: {},
        data: [
          {
            ...assistant,
            content: [
              { type: "text", id: "txt_live", text: "" },
              { type: "reasoning", id: "reason_other", text: "" },
            ],
          },
        ],
      }),
    )
    await hydration
    delta("B")
    const text = () => {
      const item = client.data.session.message.list(sessionID)?.[0]
      return item?.type === "assistant" && item.content[0]?.type === "text" ? item.content[0].text : undefined
    }
    await wait(() => text() === "A+B")
    stream.send({
      id: "evt_settle",
      type: "sync",
      syncEvent: {
        id: "evt_settle",
        aggregateID: sessionID,
        seq: 12,
        type: "session.next.text.ended.1",
        data: { sessionID, assistantMessageID: assistant.id, textID: "txt_live", text: "settled", timestamp: 3 },
      },
    })
    await wait(() => text() === "settled")
    expect(text()).toBe("settled")
  } finally {
    held.resolve(json({ sequence: 11, cursor: {}, data: [] }))
    await client.dispose()
    if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
    if (previous !== undefined) process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = previous
  }
})

for (const kind of ["reasoning", "tool input"]) {
  test(`volatile ${kind} survives an unrelated commit and settles without duplicate replay`, async () => {
    const previous = process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
    process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = "1"
    const held = Promise.withResolvers<Response>()
    const settled = Promise.withResolvers<Response>()
    const fragment =
      kind === "reasoning"
        ? { type: "reasoning", id: "frag_live", text: "" }
        : { type: "tool", id: "frag_live", name: "bash", time: { created: 0 }, state: { status: "pending", input: "" } }
    const assistant = {
      id: "msg_fragments",
      type: "assistant",
      agent: "build",
      model: { id: "fake", providerID: "local" },
      content: [fragment],
      time: { created: 0 },
    }
    let reads = 0
    const client = await mountRecovery((url) => {
      if (url.pathname !== `/api/session/${sessionID}/message`) return
      reads++
      if (reads === 1) return json({ sequence: 10, cursor: {}, data: [assistant] })
      return reads === 2 ? held.promise : settled.promise
    })
    try {
      client.route.navigate({ type: "session", sessionID })
      await client.sdk.eventsReady()
      await client.data.session.message.refresh(sessionID)
      const stream = client.streams.at(-1)!
      const value = () => {
        const item = client.data.session.message.list(sessionID)?.[0]
        const part = item?.type === "assistant" ? item.content.find((part) => part.id === "frag_live") : undefined
        if (part?.type === "tool") return part.state.input
        if (part?.type === "reasoning") return part.text
      }
      const delta = (text: string) => {
        if (kind === "reasoning")
          return stream.send({
            id: `evt_reason_${text}`,
            type: "session.next.reasoning.delta",
            properties: {
              sessionID,
              assistantMessageID: assistant.id,
              reasoningID: "frag_live",
              delta: text,
              timestamp: 1,
            },
          })
        stream.send({
          id: `evt_input_${text}`,
          type: "session.next.tool.input.delta",
          properties: { sessionID, assistantMessageID: assistant.id, callID: "frag_live", delta: text, timestamp: 1 },
        })
      }
      delta("A")
      await wait(() => value() === "A")
      const hydration = client.data.session.message.refresh(sessionID)
      await wait(() => reads === 2)
      delta("+")
      await wait(() => value() === "A+")
      stream.send({
        id: "evt_other_fragment",
        type: "sync",
        syncEvent: {
          id: "evt_other_fragment",
          aggregateID: sessionID,
          seq: 11,
          type: "session.next.text.ended.1",
          data: { sessionID, assistantMessageID: assistant.id, textID: "txt_other", text: "persisted", timestamp: 2 },
        },
      })
      held.resolve(
        json({
          sequence: 11,
          cursor: {},
          data: [
            {
              ...assistant,
              content: [fragment, { type: "text", id: "txt_other", text: "persisted" }],
            },
          ],
        }),
      )
      await hydration
      expect(value()).toBe("A+")

      const finalHydration = client.data.session.message.refresh(sessionID)
      await wait(() => reads === 3)
      if (kind === "reasoning")
        stream.send({
          id: "evt_settlement",
          type: "sync",
          syncEvent: {
            id: "evt_settlement",
            aggregateID: sessionID,
            seq: 12,
            type: "session.next.reasoning.ended.1",
            data: {
              sessionID,
              assistantMessageID: assistant.id,
              reasoningID: "frag_live",
              text: "settled",
              timestamp: 3,
            },
          },
        })
      if (kind === "tool input")
        stream.send({
          id: "evt_settlement",
          type: "sync",
          syncEvent: {
            id: "evt_settlement",
            aggregateID: sessionID,
            seq: 12,
            type: "session.next.tool.input.ended.1",
            data: { sessionID, assistantMessageID: assistant.id, callID: "frag_live", text: "settled", timestamp: 3 },
          },
        })
      await wait(() => value() === "settled")
      settled.resolve(
        json({
          sequence: 12,
          cursor: {},
          data: [
            {
              ...assistant,
              content: [
                kind === "reasoning"
                  ? { ...fragment, text: "settled" }
                  : { ...fragment, state: { status: "pending", input: "settled" } },
              ],
            },
          ],
        }),
      )
      await finalHydration
      expect(value()).toBe("settled")
    } finally {
      held.resolve(json({ sequence: 11, cursor: {}, data: [] }))
      settled.resolve(json({ sequence: 12, cursor: {}, data: [] }))
      await client.dispose()
      if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST
      if (previous !== undefined) process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST = previous
    }
  })
}

test("foreign MCP changes refresh the client's Location and actions use that same Location", async () => {
  const foreign = "/foreign/project"
  const client = await mountRecovery(
    (url) => {
      if (url.pathname === "/mcp")
        return json({ shared: { status: url.searchParams.get("directory") === foreign ? "connected" : "disabled" } })
      if (url.pathname === "/experimental/resource")
        return json({ local: { name: "local", uri: "local://resource", client: "shared" } })
      if (url.pathname === "/mcp/shared/connect") return json(true)
    },
    true,
    { "x-opencode-workspace": "local-workspace" },
  )
  try {
    await wait(() => client.sync.status === "complete")
    const before = client.requests.filter((request) => new URL(request.url).pathname === "/mcp").length
    const resources = client.requests.filter(
      (request) => new URL(request.url).pathname === "/experimental/resource",
    ).length
    client.streams
      .at(-1)!
      .send(
        { id: "evt_foreign_mcp", type: "mcp.tools.changed", properties: { server: "shared" } },
        foreign,
        "foreign-workspace",
      )
    await wait(() => client.requests.filter((request) => new URL(request.url).pathname === "/mcp").length > before)
    await wait(
      () =>
        client.requests.filter((request) => new URL(request.url).pathname === "/experimental/resource").length >
        resources,
    )
    await wait(() => client.sync.data.mcp_resource.local !== undefined)
    expect(client.sync.data.mcp.shared).toEqual({ status: "disabled" })
    await client.sdk.client.mcp.connect({ name: "shared" }, { throwOnError: true })
    const operations = client.requests.filter((request) =>
      ["/mcp", "/experimental/resource", "/mcp/shared/connect"].includes(new URL(request.url).pathname),
    )
    expect(
      operations.map(
        (request) =>
          new URL(request.url).searchParams.get("directory") ??
          decodeURIComponent(request.headers.get("x-opencode-directory") ?? ""),
      ),
    ).toEqual(operations.map(() => directory))
    expect(
      operations.map(
        (request) => new URL(request.url).searchParams.get("workspace") ?? request.headers.get("x-opencode-workspace"),
      ),
    ).toEqual(operations.map(() => "local-workspace"))
  } finally {
    await client.dispose()
  }
})

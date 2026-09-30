import { expect, test } from "bun:test"
import { createConnection, createServer, type Socket } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createOpencodeClient, type Session, type SessionWorkStateInfo } from "@opencode-ai/sdk/v2"
import type { TuiDispose, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import { Schema } from "effect"
import { createHerdrActivityReporter } from "../../src/util/herdr-activity"
import HerdrActivity from "../../src/feature-plugins/system/herdr-activity"
import { createTuiPluginApi } from "../fixture/tui-plugin"

const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.String,
      params: Schema.Struct({ agent_session_id: Schema.String, state: Schema.optional(Schema.String) }),
    }),
  ),
)

test("switching sessions aborts an old activity request and never publishes its late result", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oc-herdr-"))
  const reports: Array<{ method: string; params: { agent_session_id: string; state?: string } }> = []
  const ready = Promise.withResolvers<void>()
  const started = Promise.withResolvers<AbortSignal>()
  const reread = Promise.withResolvers<void>()
  const held = Promise.withResolvers<SessionWorkStateInfo>()
  const socketPath = path.join(directory, "herdr.sock")
  const server = createServer((socket) =>
    socket.on("data", (data) => {
      const report = decode(data.toString())
      reports.push(report)
      if (report.params.state === "working") ready.resolve()
      socket.end('{"result":{}}\n')
    }),
  )
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  let selected = "ses_a"
  let reads = 0
  const dispose = createHerdrActivityReporter({
    current: () => selected,
    socketPath,
    paneID: "test:p1",
    interval: 10,
    async read(id, signal) {
      if (id === "ses_a") {
        started.resolve(signal)
        return held.promise
      }
      reads++
      if (reads >= 2) reread.resolve()
      return { type: "working", foreground: "idle", agents: 1, shells: 0 }
    },
  })
  try {
    const signal = await started.promise
    selected = "ses_b"
    await ready.promise
    expect(signal.aborted).toBe(true)
    held.resolve({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
    await reread.promise
    expect(reports.map((report) => report.params.agent_session_id)).toEqual(["ses_b", "ses_b"])
    expect(reports.filter((report) => report.params.state).map((report) => report.params.state)).toEqual(["working"])
  } finally {
    dispose()
    held.resolve({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      method: Schema.String,
      params: Schema.Struct({
        pane_id: Schema.String,
        source: Schema.String,
        agent: Schema.String,
        agent_session_id: Schema.String,
        session_start_source: Schema.optional(Schema.String),
        state: Schema.optional(Schema.String),
        seq: Schema.optional(Schema.Number),
      }),
    }),
  ),
)

type Report = ReturnType<typeof decodeRequest>

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Herdr activity")
    await Bun.sleep(5)
  }
}

function activity(type: SessionWorkStateInfo["type"] = "working"): SessionWorkStateInfo {
  return { type, foreground: "idle", agents: 0, shells: type === "working" ? 1 : 0 }
}

// Real newline-framed Unix RPC, including connections held open during route/disposal races.
async function socketFixture(reply?: (report: Report, socket: Socket) => void) {
  const directory = await mkdtemp(path.join(tmpdir(), "oc-herdr-"))
  const socketPath = path.join(directory, "herdr.sock")
  const reports: Report[] = []
  const sockets = new Set<Socket>()
  const disposers: Array<() => void> = []
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on("error", () => socket.destroy())
    socket.once("close", () => sockets.delete(socket))
    let frame = ""
    socket.on("data", (data) => {
      frame += data.toString()
      const end = frame.indexOf("\n")
      if (end < 0) return
      const report = decodeRequest(frame.slice(0, end))
      reports.push(report)
      if (reply) return reply(report, socket)
      socket.end(JSON.stringify({ id: report.id, result: { type: "ok" } }) + "\n")
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, resolve)
  })
  return {
    socketPath,
    reports,
    sockets,
    start(input: Pick<Parameters<typeof createHerdrActivityReporter>[0], "read" | "current">) {
      const dispose = createHerdrActivityReporter({ ...input, paneID: "test:p1", socketPath, interval: 10 })
      disposers.push(dispose)
      return dispose
    },
    async [Symbol.asyncDispose]() {
      disposers.forEach((dispose) => dispose())
      sockets.forEach((socket) => socket.destroy())
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test("aggregate shell activity keeps polling through foreground idle and eventually reports idle", async () => {
  await using fixture = await socketFixture()
  let state = activity()
  let reads = 0
  fixture.start({
    current: () => "ses_root",
    read: async () => {
      reads++
      return state
    },
  })
  await waitFor(() => fixture.reports.length === 2)
  const working = fixture.reports[1]!
  expect(fixture.reports[0]!.params).toEqual({
    pane_id: "test:p1",
    source: "herdr:opencode",
    agent: "opencode",
    agent_session_id: "ses_root",
    session_start_source: "select",
  })
  expect(working.method).toBe("pane.report_agent")
  expect(working.params.state).toBe("working")
  expect(working.params.seq).toBeGreaterThanOrEqual((Date.now() - 1000) * 1000)
  expect(Number.isSafeInteger(working.params.seq)).toBe(true)
  await waitFor(() => reads >= 5)
  expect(fixture.reports).toHaveLength(2)
  state = activity("blocked")
  await waitFor(() => fixture.reports.at(-1)?.params.state === "blocked")
  state = activity("idle")
  await waitFor(() => fixture.reports.at(-1)?.params.state === "idle")
  expect(fixture.reports.map((report) => report.params.state).filter(Boolean)).toEqual(["working", "blocked", "idle"])
  expect(fixture.reports.at(-1)!.params.seq).toBeGreaterThan(working.params.seq!)
})

test("selection acknowledgement rereads activity rather than publishing an obsolete idle snapshot", async () => {
  let selection: Socket | undefined
  await using fixture = await socketFixture((report, socket) => {
    if (report.method === "pane.report_agent_session") {
      selection = socket
      return
    }
    socket.end(JSON.stringify({ id: report.id, result: { type: "ok" } }) + "\n")
  })
  let state = activity("idle")
  fixture.start({ current: () => "ses_root", read: async () => state })
  await waitFor(() => !!selection)
  state = activity()
  selection!.end('{"result":{}}\n')
  await waitFor(() => fixture.reports.length === 2)
  expect(fixture.reports[1]!.params.state).toBe("working")
})

test("a failed post-selection reread does not publish the pre-selection snapshot", async () => {
  await using fixture = await socketFixture()
  let reads = 0
  let recover = false
  fixture.start({
    current: () => "ses_root",
    async read() {
      reads++
      if (reads === 1) return activity("idle")
      if (!recover) throw new Error("Activity unavailable after selection")
      return activity()
    },
  })
  await waitFor(() => reads >= 4)
  expect(fixture.reports.map((report) => report.method)).toEqual(["pane.report_agent_session"])
  recover = true
  await waitFor(() => fixture.reports.length === 2)
  expect(fixture.reports[1]!.params.state).toBe("working")
})

test("reads do not overlap and returning to a session cannot revive its previous in-flight read", async () => {
  await using fixture = await socketFixture()
  const held = Promise.withResolvers<SessionWorkStateInfo>()
  const signals: AbortSignal[] = []
  let selected = "ses_a"
  fixture.start({
    current: () => selected,
    async read(id, signal) {
      signals.push(signal)
      if (signals.length === 1) return held.promise
      return activity(id === "ses_b" ? "blocked" : "working")
    },
  })
  await waitFor(() => signals.length === 1)
  await Bun.sleep(40)
  expect(signals).toHaveLength(1)
  selected = "ses_b"
  await waitFor(() => fixture.reports.at(-1)?.params.state === "blocked")
  selected = "ses_a"
  await waitFor(() => fixture.reports.at(-1)?.params.state === "working")
  expect(signals[0]!.aborted).toBe(true)
  held.resolve(activity("idle"))
  const reads = signals.length
  await waitFor(() => signals.length > reads)
  expect(fixture.reports.map((report) => report.params.state).filter(Boolean)).toEqual(["blocked", "working"])
})

test.each(["rpc-error", "malformed", "empty", "wrong-id", "closed", "timeout"])(
  "selection %s retries without publishing state before acknowledgement",
  async (failure) => {
    let accepted = false
    await using fixture = await socketFixture((report, socket) => {
      if (!accepted) {
        accepted = true
        if (failure === "rpc-error") return void socket.end('{"error":{"code":"pane_not_found","message":"missing"}}\n')
        if (failure === "malformed") return void socket.end("not json\n")
        if (failure === "empty") return void socket.end("{}\n")
        if (failure === "wrong-id") return void socket.end('{"id":"another-request","result":{}}\n')
        if (failure === "closed") return void socket.end()
        return
      }
      socket.end(JSON.stringify({ id: report.id, result: { type: "ok" } }) + "\n")
    })
    fixture.start({ current: () => "ses_root", read: async () => activity() })
    await waitFor(() => fixture.reports.some((report) => report.params.state === "working"))
    expect(fixture.reports.map((report) => report.method)).toEqual([
      "pane.report_agent_session",
      "pane.report_agent_session",
      "pane.report_agent",
    ])
  },
)

test("split replies wait for a full frame and rejected state reports are retried with a newer sequence", async () => {
  const replies: Array<{ report: Report; socket: Socket }> = []
  await using fixture = await socketFixture((report, socket) => {
    replies.push({ report, socket })
    socket.write('{"id":')
  })
  fixture.start({ current: () => "ses_root", read: async () => activity() })
  await waitFor(() => replies.length === 1)
  await Bun.sleep(30) // Deliberately keep a partial RPC frame in flight across polls.
  expect(fixture.reports).toHaveLength(1)
  replies[0]!.socket.end(JSON.stringify(replies[0]!.report.id) + ',"result":{"type":"ok"}}\n')
  await waitFor(() => replies.length === 2)
  replies[1]!.socket.end(JSON.stringify(replies[1]!.report.id) + ',"error":{"code":"rejected"}}\n')
  await waitFor(() => replies.length === 3)
  expect(replies[2]!.report.params.seq).toBeGreaterThan(replies[1]!.report.params.seq!)
  replies[2]!.socket.end(JSON.stringify(replies[2]!.report.id) + ',"result":{"type":"ok"}}\n')
  await Bun.sleep(30)
  expect(fixture.reports).toHaveLength(3)
})

test("switching routes during selection IPC aborts the socket and suppresses the old state", async () => {
  let held: Socket | undefined
  await using fixture = await socketFixture((report, socket) => {
    if (report.params.agent_session_id === "ses_a") {
      held = socket
      return
    }
    socket.end(JSON.stringify({ id: report.id, result: { type: "ok" } }) + "\n")
  })
  let selected: string | undefined = "ses_a"
  fixture.start({ current: () => selected, read: async () => activity("idle") })
  await waitFor(() => !!held)
  selected = "ses_b"
  await waitFor(() =>
    fixture.reports.some((report) => report.params.agent_session_id === "ses_b" && report.params.state),
  )
  await waitFor(() => !!held?.destroyed)
  expect(fixture.reports.map((report) => [report.params.agent_session_id, report.params.state])).toEqual([
    ["ses_a", undefined],
    ["ses_b", undefined],
    ["ses_b", "idle"],
  ])
  selected = undefined
  const count = fixture.reports.length
  await Bun.sleep(40)
  expect(fixture.reports).toHaveLength(count)
})

test("disposal aborts a pending read and ignores its late completion", async () => {
  await using fixture = await socketFixture()
  const held = Promise.withResolvers<SessionWorkStateInfo>()
  let signal: AbortSignal | undefined
  let reads = 0
  const dispose = fixture.start({
    current: () => "ses_root",
    read: async (_id, value) => {
      reads++
      signal = value
      return held.promise
    },
  })
  await waitFor(() => !!signal)
  dispose()
  dispose()
  expect(signal!.aborted).toBe(true)
  held.resolve(activity("idle"))
  await Bun.sleep(40)
  expect(reads).toBe(1)
  expect(fixture.reports).toEqual([])
})

test("disposal aborts a pending RPC without publishing idle or release", async () => {
  await using fixture = await socketFixture(() => {})
  const dispose = fixture.start({ current: () => "ses_root", read: async () => activity() })
  await waitFor(() => fixture.reports.length === 1)
  dispose()
  await waitFor(() => fixture.sockets.size === 0)
  await Bun.sleep(30)
  expect(fixture.reports.map((report) => report.method)).toEqual(["pane.report_agent_session"])
})

test("disposal cancels scheduled reselection after a successful acknowledgement", async () => {
  await using fixture = await socketFixture()
  const dispose = fixture.start({ current: () => "ses_root", read: async () => activity() })
  await waitFor(() => fixture.reports.length === 2)
  dispose()
  await Bun.sleep(150)
  expect(fixture.reports).toHaveLength(2)
})

test("timestamp sequences supersede legacy foreground idle hooks and unchanged state is refreshed", async () => {
  // Herdr accepts only a strictly newer sequence per source; an unsequenced
  // select does not advance that watermark. Legacy hooks increment a startup timestamp.
  const legacySeq = (Date.now() - 1000) * 1000 + 2
  let watermark = legacySeq
  let state = "idle"
  await using fixture = await socketFixture((report, socket) => {
    if (report.params.seq !== undefined && report.params.seq > watermark) {
      watermark = report.params.seq
      state = report.params.state!
    }
    socket.end(JSON.stringify({ id: report.id, result: { type: "ok" } }) + "\n")
  })
  fixture.start({ current: () => "ses_root", read: async () => activity() })
  await waitFor(() => state === "working")
  expect(watermark).toBeGreaterThan(legacySeq)
  await new Promise<void>((resolve, reject) => {
    const client = createConnection(fixture.socketPath, () =>
      client.write(
        JSON.stringify({
          id: "legacy-idle",
          method: "pane.report_agent",
          params: {
            pane_id: "test:p1",
            source: "herdr:opencode",
            agent: "opencode",
            agent_session_id: "ses_root",
            state: "idle",
            seq: legacySeq + 1,
          },
        }) + "\n",
      ),
    )
    client.once("data", () => {
      client.destroy()
      resolve()
    })
    client.once("error", reject)
  })
  expect(state).toBe("working")
  await waitFor(() => fixture.reports.filter((report) => report.params.state === "working").length === 2)
  expect(state).toBe("working")
  expect(fixture.reports.at(-1)!.params.seq).toBeGreaterThan(fixture.reports[1]!.params.seq!)
})

function herdrEnv(values: { HERDR_ENV?: string; HERDR_PANE_ID?: string; HERDR_SOCKET_PATH?: string }) {
  const previous = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
  }
  const set = (value: typeof values) => {
    Object.keys(previous).forEach((key) => {
      const item = value[key as keyof typeof values]
      if (item === undefined) delete process.env[key]
      else process.env[key] = item
    })
  }
  set(values)
  return { [Symbol.dispose]: () => set(previous) }
}

function session(id: string, parentID?: string): Session {
  return {
    id,
    parentID,
    title: id,
    slug: id,
    projectID: "project",
    directory: "/workspace",
    version: "test",
    time: { created: 0, updated: 0 },
  }
}

async function pluginFixture(initial = "ses_root") {
  const sessions = new Map<string, Session>([[initial, session(initial)]])
  const requests: string[] = []
  const disposers: TuiDispose[] = []
  let route: TuiRouteCurrent = { name: "session", params: { sessionID: initial } }
  let status = 200
  let state = activity()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname)
      return Response.json(status === 200 ? state : { error: "Activity unavailable" }, { status })
    },
  })
  const api = createTuiPluginApi({
    client: createOpencodeClient({ baseUrl: server.url.toString() }),
    state: { session: { get: (id) => sessions.get(id) } },
  })
  api.route = {
    get current() {
      return route
    },
    register: () => () => {},
    navigate: () => {},
  }
  api.lifecycle = {
    signal: new AbortController().signal,
    onDispose(dispose) {
      disposers.push(dispose)
      return () => {}
    },
  }
  return {
    sessions,
    requests,
    disposers,
    route(value: TuiRouteCurrent) {
      route = value
    },
    response(value: SessionWorkStateInfo, code = 200) {
      state = value
      status = code
    },
    async boot() {
      await HerdrActivity.tui(api)
    },
    async [Symbol.asyncDispose]() {
      await Promise.all(disposers.map((dispose) => dispose()))
      await server.stop(true)
    },
  }
}

test.each([
  { HERDR_ENV: undefined, HERDR_PANE_ID: "test:p1", HERDR_SOCKET_PATH: "socket" },
  { HERDR_ENV: "0", HERDR_PANE_ID: "test:p1", HERDR_SOCKET_PATH: "socket" },
  { HERDR_ENV: "1", HERDR_PANE_ID: undefined, HERDR_SOCKET_PATH: "socket" },
  { HERDR_ENV: "1", HERDR_PANE_ID: "test:p1", HERDR_SOCKET_PATH: undefined },
])("plugin does not boot outside a complete Herdr environment: %j", async (values) => {
  using env = herdrEnv(values)
  await using plugin = await pluginFixture()
  await plugin.boot()
  expect(plugin.disposers).toHaveLength(0)
  expect(plugin.requests).toEqual([])
})

test("plugin retains root boundary across nested browsing and home, then selects an unrelated session", async () => {
  await using fixture = await socketFixture()
  using env = herdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "test:p1", HERDR_SOCKET_PATH: fixture.socketPath })
  await using plugin = await pluginFixture()
  plugin.sessions.set("ses_child", session("ses_child", "ses_root"))
  plugin.sessions.set("ses_nested", session("ses_nested", "ses_child"))
  plugin.sessions.set("ses_other", session("ses_other"))
  await plugin.boot()
  await waitFor(() => fixture.reports.length === 2)
  plugin.route({ name: "session", params: { sessionID: "ses_nested" } })
  const reads = plugin.requests.length
  await waitFor(() => plugin.requests.length > reads)
  plugin.route({ name: "home" })
  await waitFor(() => plugin.requests.length > reads + 1)
  expect(new Set(plugin.requests)).toEqual(new Set(["/session/ses_root/activity"]))
  plugin.route({ name: "session", params: { sessionID: "ses_other" } })
  await waitFor(() =>
    fixture.reports.some((report) => report.params.agent_session_id === "ses_other" && report.params.state),
  )
  expect(
    new Set(
      fixture.reports
        .filter((report) => report.method === "pane.report_agent_session")
        .map((report) => report.params.agent_session_id),
    ),
  ).toEqual(new Set(["ses_root", "ses_other"]))
})

test("plugin waits on home and unhydrated startup before selecting a session", async () => {
  await using fixture = await socketFixture()
  using env = herdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "test:p1", HERDR_SOCKET_PATH: fixture.socketPath })
  await using plugin = await pluginFixture()
  plugin.route({ name: "home" })
  await plugin.boot()
  await Bun.sleep(300)
  expect(plugin.requests).toEqual([])
  plugin.route({ name: "session", params: { sessionID: "ses_pending" } })
  await Bun.sleep(300)
  expect(plugin.requests).toEqual([])
  expect(fixture.reports).toEqual([])
  plugin.sessions.set("ses_pending", session("ses_pending"))
  await waitFor(() => fixture.reports.length === 2)
  expect(fixture.reports[0]!.params.agent_session_id).toBe("ses_pending")
})

test("direct child attachment observes that subtree and preserves it when browsing deeper", async () => {
  await using fixture = await socketFixture()
  using env = herdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "test:p1", HERDR_SOCKET_PATH: fixture.socketPath })
  await using plugin = await pluginFixture("ses_child")
  plugin.sessions.set("ses_root", session("ses_root"))
  plugin.sessions.set("ses_child", session("ses_child", "ses_root"))
  plugin.sessions.set("ses_nested", session("ses_nested", "ses_child"))
  await plugin.boot()
  await waitFor(() => fixture.reports.length === 2)
  plugin.route({ name: "session", params: { sessionID: "ses_nested" } })
  const reads = plugin.requests.length
  await waitFor(() => plugin.requests.length > reads)
  expect(new Set(plugin.requests)).toEqual(new Set(["/session/ses_child/activity"]))
  expect(fixture.reports.every((report) => report.params.agent_session_id === "ses_child")).toBe(true)
})

test("incomplete or cyclic ancestry pauses attribution until hydration restores the root boundary", async () => {
  await using fixture = await socketFixture()
  using env = herdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "test:p1", HERDR_SOCKET_PATH: fixture.socketPath })
  await using plugin = await pluginFixture()
  await plugin.boot()
  await waitFor(() => fixture.reports.length === 2)
  plugin.route({ name: "session", params: { sessionID: "ses_nested" } })
  plugin.response(activity("idle"))
  await Bun.sleep(300) // Let an entire route poll run with unhydrated ancestry.
  expect(fixture.reports.some((report) => report.params.state === "idle")).toBe(false)
  plugin.sessions.set("ses_nested", session("ses_nested", "ses_child"))
  plugin.sessions.set("ses_child", session("ses_child", "ses_nested"))
  await Bun.sleep(300)
  expect(fixture.reports.filter((report) => report.method === "pane.report_agent_session")).toHaveLength(1)
  plugin.sessions.set("ses_child", session("ses_child", "ses_root"))
  await waitFor(() => fixture.reports.at(-1)?.params.state === "idle")
  expect(fixture.reports.at(-1)!.params.agent_session_id).toBe("ses_root")
  expect(new Set(plugin.requests)).toEqual(new Set(["/session/ses_root/activity"]))
})

test("plugin retries HTTP 404 and 503 without declaring idle and disposes its poll", async () => {
  await using fixture = await socketFixture()
  using env = herdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "test:p1", HERDR_SOCKET_PATH: fixture.socketPath })
  await using plugin = await pluginFixture()
  await plugin.boot()
  await waitFor(() => fixture.reports.length === 2)
  plugin.response(activity("idle"), 404)
  const reads = plugin.requests.length
  await waitFor(() => plugin.requests.length > reads + 1)
  expect(fixture.reports.map((report) => report.params.state).filter(Boolean)).toEqual(["working"])
  plugin.response(activity("idle"), 503)
  await waitFor(() => plugin.requests.length > reads + 2)
  expect(fixture.reports.map((report) => report.params.state).filter(Boolean)).toEqual(["working"])
  plugin.response(activity("blocked"))
  await waitFor(() => fixture.reports.at(-1)?.params.state === "blocked")
  await Promise.all(plugin.disposers.map((dispose) => dispose()))
  const count = plugin.requests.length
  await Bun.sleep(300)
  expect(plugin.requests).toHaveLength(count)
})

test("acknowledged startup selections retry through late foreground detection, replay state, then stop selecting", async () => {
  const selections: number[] = []
  const applied: number[] = []
  let root = "ses_old"
  let state = "blocked"
  let watermark = (Date.now() - 1000) * 1000
  await using fixture = await socketFixture((report, socket) => {
    // Match Herdr's live behavior: ignored selections/states still return ok,
    // select does not reset the per-source watermark, and state cannot switch roots.
    if (report.method === "pane.report_agent_session") {
      selections.push(Date.now())
      if (selections.length >= 4) root = report.params.agent_session_id
    }
    if (
      report.params.state &&
      selections.length >= 4 &&
      report.params.agent_session_id === root &&
      report.params.seq! > watermark
    ) {
      watermark = report.params.seq!
      state = report.params.state
      applied.push(Date.now())
    }
    socket.end(JSON.stringify({ id: report.id, result: { type: "ok" } }) + "\n")
  })
  fixture.start({ current: () => "ses_root", read: async () => activity() })
  await waitFor(() => selections.length === 3)
  expect(root).toBe("ses_old")
  expect(state).toBe("blocked")
  await waitFor(() => state === "working")
  expect(root).toBe("ses_root")
  expect(selections).toHaveLength(4)
  expect(selections[1]! - selections[0]!).toBeGreaterThanOrEqual(100)
  expect(selections[2]! - selections[1]!).toBeGreaterThanOrEqual(400)
  expect(selections[3]! - selections[2]!).toBeGreaterThanOrEqual(1000)
  const reports = fixture.reports.filter((report) => report.params.state)
  expect(reports.map((report) => report.params.state)).toEqual(["working", "working", "working", "working"])
  expect(reports.every((report, index) => index === 0 || report.params.seq! > reports[index - 1]!.params.seq!)).toBe(
    true,
  )
  expect(
    fixture.reports
      .filter((report) => report.method === "pane.report_agent_session")
      .every((report) => report.params.seq === undefined),
  ).toBe(true)
  await waitFor(() => applied.length >= 2)
  expect(applied[1]! - applied[0]!).toBeGreaterThanOrEqual(1000)
  expect(selections).toHaveLength(4)
})

test("switching roots cancels acknowledged-selection retries and rejects a stale-root report even when acked", async () => {
  let root: string | undefined
  let state = "idle"
  let watermark = 0
  await using fixture = await socketFixture((report, socket) => {
    if (report.method === "pane.report_agent_session") root = report.params.agent_session_id
    if (report.params.state && report.params.agent_session_id === root && report.params.seq! > watermark) {
      watermark = report.params.seq!
      state = report.params.state
    }
    socket.end(JSON.stringify({ id: report.id, result: { type: "ok" } }) + "\n")
  })
  let selected = "ses_a"
  const dispose = fixture.start({ current: () => selected, read: async () => activity() })
  await waitFor(() => state === "working")
  selected = "ses_b"
  await waitFor(() => root === "ses_b" && fixture.reports.at(-1)?.params.state === "working")
  const switched = fixture.reports.findIndex((report) => report.params.agent_session_id === "ses_b")
  await waitFor(
    () =>
      fixture.reports.filter(
        (report) => report.method === "pane.report_agent_session" && report.params.agent_session_id === "ses_b",
      ).length === 4,
  )
  expect(fixture.reports.slice(switched).every((report) => report.params.agent_session_id === "ses_b")).toBe(true)
  dispose()
  const count = fixture.reports.length
  await new Promise<void>((resolve, reject) => {
    const client = createConnection(fixture.socketPath, () =>
      client.write(
        JSON.stringify({
          id: "stale-root",
          method: "pane.report_agent",
          params: {
            pane_id: "test:p1",
            source: "herdr:opencode",
            agent: "opencode",
            agent_session_id: "ses_a",
            state: "idle",
            seq: watermark + 1,
          },
        }) + "\n",
      ),
    )
    client.once("data", () => {
      client.destroy()
      resolve()
    })
    client.once("error", reject)
  })
  expect(root).toBe("ses_b")
  expect(state).toBe("working")
  await Bun.sleep(150)
  expect(fixture.reports).toHaveLength(count + 1)
})

test("transient activity failures preserve the last state and retry before publishing blocked", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oc-herdr-"))
  const working = Promise.withResolvers<void>()
  const failed = Promise.withResolvers<void>()
  const blocked = Promise.withResolvers<void>()
  const states: string[] = []
  const socketPath = path.join(directory, "herdr.sock")
  const server = createServer((socket) =>
    socket.on("data", (data) => {
      const report = decode(data.toString())
      if (report.params.state) {
        states.push(report.params.state)
        if (report.params.state === "working") working.resolve()
        if (report.params.state === "blocked") blocked.resolve()
      }
      socket.end('{"result":{}}\n')
    }),
  )
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  let state: "working" | "blocked" | "error" = "working"
  const dispose = createHerdrActivityReporter({
    current: () => "ses_a",
    socketPath,
    paneID: "test:p1",
    interval: 10,
    async read() {
      if (state === "error") {
        failed.resolve()
        throw new Error("Server temporarily unavailable")
      }
      return { type: state, foreground: "idle", agents: 1, shells: 0 }
    },
  })
  try {
    await working.promise
    state = "error"
    await failed.promise
    expect(states).toEqual(["working"])
    state = "blocked"
    await blocked.promise
    expect(states).toEqual(["working", "blocked"])
  } finally {
    dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

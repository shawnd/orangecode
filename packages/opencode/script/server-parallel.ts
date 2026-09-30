import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"

// Run under the common flock. Provider and HTTP clients are deterministic/local;
// this measures a daemon workload, not a fleet of interactive terminal clients.
const root = "/tmp/opencode/server-parallel"
const fixture = path.join(root, "fixture")
const label = process.argv[2] ?? "baseline"
const baseline = "/tmp/opencode/shared-server-base-bin/opencode"
const candidate = path.resolve(process.argv[3] ?? baseline)
const stats = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  return {
    n: sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    max: sorted.at(-1) ?? 0,
  }
}

if (!process.env.PARALLEL_CHILD) {
  const rows: unknown[] = []
  const arms = (process.env.PARALLEL_ARMS ?? (label === "paired" ? "baseline,candidate" : "direct,worker")).split(",")
  for (let round = 0; round < Number(process.env.PARALLEL_REPEATS ?? 3); round++) {
    for (const arm of round % 2 ? arms.toReversed() : arms) {
      const child = Bun.spawn([process.execPath, import.meta.filename, label, candidate], {
        env: { ...process.env, PARALLEL_CHILD: "1", PARALLEL_ROUND: String(round), PARALLEL_ARM: arm },
        stdout: "pipe",
        stderr: "inherit",
      })
      const output = await new Response(child.stdout).text()
      assert.equal(await child.exited, 0, output)
      const row = JSON.parse(output.trim())
      rows.push(row)
      await Bun.write(`${root}/daemon-${label}.json`, JSON.stringify(rows, null, 2))
      console.log(
        JSON.stringify({
          ...row,
          samples: undefined,
          providerEvents: undefined,
          searchSamples: undefined,
          healthSamples: undefined,
          controlSamples: undefined,
        }),
      )
    }
  }
  process.exit(0)
}

const round = Number(process.env.PARALLEL_ROUND)
const arm = process.env.PARALLEL_ARM ?? "direct"
const binary = arm === "baseline" ? baseline : candidate
const worker = arm === "candidate" || arm === "worker"
const sha256 = createHash("sha256")
  .update(new Uint8Array(await Bun.file(binary).arrayBuffer()))
  .digest("hex")
const home = path.join(root, `${label}-${round}-${arm}`)
await fs.mkdir(home, { recursive: true })
assert.ok(!(await Bun.file(`${home}/server.log`).exists()), "use a fresh label/home for every experiment")
const gate = Promise.withResolvers<void>()
const cancelGate = Promise.withResolvers<void>()
const providerEvents: Array<{ type: string; session: string; at: number }> = []
let released = 0
let calls = 0
let toolCalls = 0
let cancelCalls = 0
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { messages: Array<{ role: string; content?: unknown }> }
    const text = JSON.stringify(body.messages.find((message) => message.role === "user")?.content)
    const session = text.match(/bench-session-\d|bench-cancel/)?.[0] ?? "unknown"
    if (session === "bench-cancel") {
      cancelCalls++
      await cancelGate.promise
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    }
    calls++
    const tool = !body.messages.some((message) => message.role === "tool")
    providerEvents.push({ type: tool ? "model-arrived" : "tool-complete-next-model", session, at: performance.now() })
    if (tool) {
      toolCalls++
      await gate.promise
    }
    const delta = tool
      ? {
          tool_calls: [
            {
              index: 0,
              id: `call_${session}`,
              type: "function",
              function: {
                name: "glob",
                arguments: JSON.stringify({ pattern: "**/*.ts", limit: 1000 }),
              },
            },
          ],
        }
      : { content: "benchmark complete" }
    providerEvents.push({ type: tool ? "model-released" : "model-complete", session, at: performance.now() })
    return new Response(
      [
        { id: "bench", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
        {
          id: "bench",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ]
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      {
        headers: { "content-type": "text/event-stream" },
      },
    )
  },
})

const config = {
  model: "test/test-model",
  permission: { "*": "allow" },
  snapshot: false,
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test model",
          tool_call: true,
          attachment: false,
          reasoning: false,
          temperature: false,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 1000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "benchmark-only", baseURL: `${provider.url}v1` },
    },
  },
}
await Bun.write(path.join(home, "config.json"), JSON.stringify(config))
// Current Location config reads the XDG global document; the compatibility
// server also receives OPENCODE_CONFIG. Both resolve the same isolated profile.
await Bun.write(
  path.join(home, "config/opencode/opencode.json"),
  JSON.stringify({
    model: "test/test-model",
    snapshots: false,
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
    providers: {
      test: {
        name: "Test",
        env: [],
        api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${provider.url}v1` },
        request: { body: { apiKey: "benchmark-only" } },
        models: {
          "test-model": {
            name: "Test model",
            api: { id: "test-model" },
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 100000, output: 1000 },
          },
        },
      },
    },
  }),
)
const env = {
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: `${home}/config`,
  XDG_DATA_HOME: `${home}/data`,
  XDG_CACHE_HOME: `${home}/cache`,
  XDG_STATE_HOME: `${home}/state`,
  OPENCODE_DAEMON_DIR: `${home}/daemon`,
  OPENCODE_CONFIG: `${home}/config.json`,
  OPENCODE_SERVER_PASSWORD: "benchmark-only",
  OPENCODE_SERVER_USERNAME: "opencode",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  OPENCODE_PURE: "1",
  OPENCODE_EXPERIMENTAL_FFF_WORKER: worker ? "1" : "0",
  OPENCODE_FFF_WORKERS: "2",
  OPENCODE_FFF_DIAGNOSTICS: "1",
}
const log = Bun.file(`${home}/server.log`)
const child = Bun.spawn([binary, "--print-logs", "--log-level", "DEBUG", "server", "--daemon"], {
  cwd: fixture,
  env,
  stdout: log,
  stderr: log,
})
const started = performance.now()
let endpoint: { socket?: string; url: string } | undefined
const headers = {
  authorization: `Basic ${Buffer.from("opencode:benchmark-only").toString("base64")}`,
  "x-opencode-directory": fixture,
  "content-type": "application/json",
}
const request = async (route: string, body?: unknown, signal = AbortSignal.timeout(30_000)) => {
  assert.ok(endpoint)
  const result = await fetch(new URL(route, endpoint.url), {
    unix: endpoint.socket,
    headers,
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    signal,
  })
  if (!result.ok) assert.fail(`${route}: ${result.status} ${await result.text()}`)
  return result.status === 204 ? undefined : result.json()
}
// session.wait is deliberately unavailable on the common baseline. Observe the
// real process-global active map instead, equally in both compiled arms.
const waitForIdle = async (sessions: string[]) => {
  const deadline = performance.now() + 20_000
  while (true) {
    const active = (await request("/api/session/active")) as { data: Record<string, unknown> }
    if (sessions.every((session) => !active.data[session])) return
    assert.ok(performance.now() < deadline, `sessions did not become idle: ${sessions.join(",")}`)
    await Bun.sleep(10)
  }
}
const samples: Array<{ at: number; daemonPssKB: number; fleetPssKB: number; threads: number; pids: number[] }> = []
const pending = new Set<Promise<void>>()
const probeErrors: unknown[] = []
let monitoring = false
const descendants = async (pid: number): Promise<number[]> => {
  const tasks = await fs.readdir(`/proc/${pid}/task`).catch(() => [])
  const direct = (
    await Promise.all(
      tasks.map((task) =>
        Bun.file(`/proc/${pid}/task/${task}/children`)
          .text()
          .catch(() => ""),
      ),
    )
  ).flatMap((text) => text.trim().split(/\s+/).filter(Boolean).map(Number))
  return [...direct, ...(await Promise.all(direct.map(descendants))).flat()]
}
const monitor = setInterval(async () => {
  if (monitoring) return
  monitoring = true
  try {
    const pids = [...new Set([process.pid, child.pid, ...(await descendants(child.pid))])]
    const memory = await Promise.all(
      pids.map(async (pid) => {
        const [smaps, status] = await Promise.all([
          Bun.file(`/proc/${pid}/smaps_rollup`)
            .text()
            .catch(() => ""),
          Bun.file(`/proc/${pid}/status`)
            .text()
            .catch(() => ""),
        ])
        return {
          pid,
          pss: Number(smaps.match(/^Pss:\s+(\d+)/m)?.[1] ?? 0),
          threads: Number(status.match(/^Threads:\s+(\d+)/m)?.[1] ?? 0),
        }
      }),
    )
    samples.push({
      at: performance.now(),
      daemonPssKB: memory.find((value) => value.pid === child.pid)?.pss ?? 0,
      fleetPssKB: memory.reduce((sum, value) => sum + value.pss, 0),
      threads: memory.reduce((sum, value) => sum + value.threads, 0),
      pids,
    })
  } finally {
    monitoring = false
  }
}, 20)
let timer: ReturnType<typeof setInterval> | undefined
try {
  const endpointFile = Bun.file(`${home}/daemon/server.json`)
  while (!(await Bun.file(`${home}/daemon/server.json`).exists()) && performance.now() - started < 60_000) {
    if (child.exitCode !== null && child.exitCode !== undefined) break
    await Bun.sleep(25)
  }
  assert.ok(
    await Bun.file(`${home}/daemon/server.json`).exists(),
    JSON.stringify({
      pid: child.pid,
      exit: child.exitCode,
      elapsed: performance.now() - started,
      log: await Bun.file(`${home}/server.log`).text(),
    }),
  )
  endpoint = await endpointFile.json()
  await request("/__daemon/status")
  const startupMs = performance.now() - started
  const cold = performance.now()
  const find = (query: string, signal?: AbortSignal) =>
    request(
      `/api/fs/find?directory=${encodeURIComponent(fixture)}&query=${encodeURIComponent(query)}&type=file&limit=50`,
      undefined,
      signal,
    ) as Promise<{ data: unknown[] }>
  await find("component")
  const coldMs = performance.now() - cold
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await find("component")).data.length === 50) {
      ready = true
      break
    }
    await Bun.sleep(10)
  }
  assert.ok(ready, "indexed fixture never returned full page")
  const sessions = await Promise.all(
    Array.from({ length: 4 }, async (_, index) => {
      const created = (await request("/api/session", {
        model: { id: "test-model", providerID: "test" },
        location: { directory: fixture },
      })) as { data: { id: string } }
      await request(`/api/session/${created.data.id}/prompt`, {
        prompt: { text: `bench-session-${index}: Use glob once then finish.` },
      })
      return created.data.id
    }),
  )
  const deadline = performance.now() + 30_000
  while (toolCalls < 4 && performance.now() < deadline) await Bun.sleep(10)
  assert.equal(toolCalls, 4, await Bun.file(`${home}/server.log`).text())
  const cpuTicks = async () => {
    const fields = (await Bun.file(`/proc/${child.pid}/stat`).text()).split(") ")[1]?.split(" ") ?? []
    // CLK_TCK=100 on this host. Include reaped child CPU once (real glob's rg).
    return fields.slice(11, 15).reduce((sum, value) => sum + Number(value), 0) * 10
  }
  const cpuBefore = await cpuTicks()
  const clientCPU = process.cpuUsage()
  samples.length = 0
  const search: number[] = []
  const health: number[] = []
  const control: number[] = []
  timer = setInterval(() => {
    if (pending.size >= 32) return
    for (const [route, values] of [
      ["/global/health", health],
      ["/__daemon/status", control],
    ] as const) {
      const start = performance.now()
      const task = request(route).then(() => {
        values.push(performance.now() - start)
      })
      pending.add(task)
      void task.then(
        () => pending.delete(task),
        (error) => {
          pending.delete(task)
          probeErrors.push(error)
        },
      )
    }
  }, 5)
  released = performance.now()
  gate.resolve()
  await Promise.all(
    Array.from({ length: 8 }, async (_, client) => {
      for (let turn = 0; turn < 40; turn++) {
        const before = performance.now()
        assert.ok((await find(`component-${client + turn}`)).data.length > 0)
        search.push(performance.now() - before)
        await Bun.sleep(2)
      }
    }),
  )
  const searchElapsedMs = performance.now() - released
  const cancellation = []
  for (let attempt = 0; attempt < 12; attempt++) {
    const abort = new AbortController()
    const before = performance.now()
    let aborted = 0
    const cancel = setTimeout(() => {
      aborted = performance.now()
      abort.abort(new Error("obsolete HTTP search"))
    }, 1)
    const outcome = await find("component", abort.signal).then(
      () => "completed-before-abort",
      () => "aborted",
    )
    clearTimeout(cancel)
    const settled = performance.now()
    const probe = performance.now()
    await request("/__daemon/status")
    cancellation.push({
      outcome,
      deadlineMs: aborted ? aborted - before : null,
      settleMs: aborted ? settled - aborted : null,
      postCancelControlMs: performance.now() - probe,
    })
  }
  const cancelled = (await request("/api/session", {
    model: { id: "test-model", providerID: "test" },
    location: { directory: fixture },
  })) as { data: { id: string } }
  await request(`/api/session/${cancelled.data.id}/prompt`, { prompt: { text: "bench-cancel" } })
  const cancelDeadline = performance.now() + 20_000
  while (!cancelCalls && performance.now() < cancelDeadline) await Bun.sleep(10)
  assert.equal(cancelCalls, 1)
  const interrupt = performance.now()
  await request(`/api/session/${cancelled.data.id}/interrupt`, {})
  const interruptMs = performance.now() - interrupt
  await waitForIdle([cancelled.data.id])
  cancelGate.resolve()
  await waitForIdle(sessions)
  const elapsedMs = performance.now() - released
  clearInterval(timer)
  await Promise.all(pending)
  assert.equal(probeErrors.length, 0, String(probeErrors[0]))
  assert.equal(calls, 8, await Bun.file(`${home}/server.log`).text())
  const history = await Promise.all(sessions.map((session) => request(`/api/session/${session}/history`)))
  await Bun.write(`${home}/history.json`, JSON.stringify(history))
  assert.ok(history.every((value) => JSON.stringify(value).includes("benchmark complete")))
  assert.ok(
    history.every((value) => JSON.stringify(value).includes("component-")),
    "real glob output missing",
  )
  const active = (await request("/api/session/active")) as { data: Record<string, unknown> }
  assert.ok([...sessions, cancelled.data.id].every((session) => !active.data[session]))
  const cpuMs = (await cpuTicks()) - cpuBefore
  const use = process.cpuUsage(clientCPU)
  const cpuClientMs = (use.user + use.system) / 1000
  const logText = await Bun.file(`${home}/server.log`).text()
  assert.ok(!logText.includes("fff unavailable; using ripgrep"), "native search fell back")
  const nativeAck = logText.split("\n").filter((line) => line.includes("FFF_NATIVE_INIT"))
  if (arm === "candidate") {
    assert.ok(nativeAck.length >= 2, "compiled worker acknowledgements missing")
    assert.ok(
      nativeAck.every((line) => line.includes("fff-worker") && line.includes("$bunfs")),
      nativeAck.join("\n"),
    )
  }
  const warmSamples = samples.filter((sample) => sample.at >= released && sample.at <= released + elapsedMs)
  const toolMs = providerEvents
    .filter((event) => event.type === "tool-complete-next-model")
    .map((event) => event.at - released)
  assert.equal(toolMs.length, 4)
  console.log(
    JSON.stringify({
      label,
      round,
      arm,
      binary,
      sha256,
      startupMs,
      coldMs,
      searchElapsedMs,
      elapsedMs,
      throughput: (search.length * 1000) / searchElapsedMs,
      searchMs: stats(search),
      healthMs: stats(health),
      controlMs: stats(control),
      toolMs: stats(toolMs),
      interruptMs,
      cancellation,
      cpuMs,
      cpuClientMs,
      cpuFleetMs: cpuMs + cpuClientMs,
      daemonPssKB: stats(warmSamples.map((sample) => sample.daemonPssKB)),
      fleetPssKB: stats(warmSamples.map((sample) => sample.fleetPssKB)),
      threads: stats(warmSamples.map((sample) => sample.threads)),
      calls,
      toolCalls,
      nativeAck,
      providerEvents,
      samples,
      searchSamples: search,
      healthSamples: health,
      controlSamples: control,
      home,
    }),
  )
} finally {
  clearInterval(monitor)
  clearInterval(timer)
  gate.resolve()
  cancelGate.resolve()
  await Promise.allSettled(pending)
  if (endpoint) await request("/__daemon/stop", {}).catch(() => child.kill())
  if (!endpoint) child.kill()
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 15_000)
  await child.exited
  clearTimeout(watchdog)
  provider.stop(true)
}

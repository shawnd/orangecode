import { Effect, Exit, Scope } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { GlobalBus } from "../src/bus/global"
import { eventResponse } from "../src/server/routes/instance/httpapi/handlers/global"

// Exercise the production response/encoding/subscription with a real HTTP reader.
// No project, model, user config or provider is needed by this handler.
const mode = process.argv[2] ?? "slow"
const count = mode === "slow" ? 2000 : 1000
const size = mode === "slow" ? 65536 : 256
const scope = Effect.runSync(Scope.make())
const backlog = { maxBytes: 0, maxEvents: 0, reason: undefined as string | undefined }
const response = await Effect.runPromise(
  eventResponse(process.argv.includes("--bounded"), (state) => {
    backlog.maxBytes = Math.max(backlog.maxBytes, state.bytes)
    backlog.maxEvents = Math.max(backlog.maxEvents, state.events)
    backlog.reason = state.reason ?? backlog.reason
  }).pipe(Effect.provideService(Scope.Scope, scope)),
)
const server = Bun.serve({
  port: 0,
  fetch: () => HttpServerResponse.toWeb(response),
})
const abort = new AbortController()
const body = (await fetch(`http://localhost:${server.port}`, { signal: abort.signal })).body
if (!body) throw new Error("SSE response has no body")
const reader = body.getReader()
await reader.read()
// server.connected precedes installation of the callback; read again concurrently
// and await the observable bus subscription before producing any workload.
const pending = reader.read()
while (GlobalBus.listenerCount("event") === 0) await Bun.sleep(1)
const pss = async () =>
  Number((await Bun.file(`/proc/${process.pid}/smaps_rollup`).text()).match(/^Pss:\s+(\d+)/m)?.[1])
const beforePss = await pss()
const cpu = process.cpuUsage()
const start = performance.now()
const latencies: number[] = []
let received = 0
let wire = ""
const consume = async () => {
  let next = await pending
  while (!next.done && received < count) {
    wire += new TextDecoder().decode(next.value)
    const frames = wire.split("\n\n")
    wire = frames.pop() ?? ""
    for (const frame of frames) {
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
      if (!data) continue
      const event = JSON.parse(data)
      if (event.payload.type !== "bench") continue
      received++
      latencies.push(performance.now() - event.payload.properties.sent)
    }
    if (received < count) next = await reader.read()
  }
}
const consuming = mode === "normal" ? consume() : undefined
let offeredBytes = 0
let produced = 0
for (let i = 0; i < count; i++) {
  const event = {
    directory: "/queues-fixture",
    payload: { type: "bench", properties: { i, sent: performance.now(), text: `${i}:` + "x".repeat(size) } },
  }
  offeredBytes += Buffer.byteLength(JSON.stringify(event))
  GlobalBus.emit("event", event)
  produced++
  if (mode === "normal") await Bun.sleep(1)
}
if (consuming) await consuming
const elapsed = performance.now() - start
await Bun.sleep(50) // allow the HTTP writer to settle into real backpressure
const afterSettlePss = await pss()
const used = process.cpuUsage(cpu)
abort.abort()
await pending.catch(() => {})
await reader.cancel().catch(() => {})
await Effect.runPromise(Scope.close(scope, Exit.void))
server.stop(true)
latencies.sort((a, b) => a - b)
console.log(
  JSON.stringify({
    mode,
    count,
    size,
    offeredBytes,
    produced,
    received,
    beforePssKB: beforePss,
    afterSettlePssKB: afterSettlePss,
    cpuMs: (used.user + used.system) / 1000,
    elapsedMs: elapsed,
    p99Ms: latencies[Math.floor(latencies.length * 0.99)] ?? null,
    listenersAfter: GlobalBus.listenerCount("event"),
    backlog: process.argv.includes("--bounded") ? backlog : null,
  }),
)

import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { GlobalBus } from "../../src/bus/global"
import { eventResponse } from "../../src/server/routes/instance/httpapi/handlers/global"
import { SDKProvider } from "../../../tui/src/context/sdk"
import { DataProvider, useData } from "../../../tui/src/context/data"
import { useSDK } from "../../../tui/src/context/sdk"
import { makeEventInterest } from "../../src/server/event-interest"

// Deliberately measure the production SSE serializer, SDK parser, and Data store
// together. This is an in-process mechanism probe, not a fleet-memory estimate.
test.skipIf(!process.env.EVENT_BENCH)("production event delivery/store benchmark", async () => {
  const controllers = [new AbortController(), new AbortController()]
  const counts = [0, 0]
  const bytes = [0, 0]
  const stores: ReturnType<typeof useData>[] = []
  const ready = Promise.withResolvers<void>()
  let connected = 0
  const sources = controllers.map((controller, index) => ({
    async subscribe(handler: Parameters<import("../../../tui/src/context/sdk").EventSource["subscribe"]>[0]) {
      const response = HttpServerResponse.toWeb(await Effect.runPromise(eventResponse(process.env.EVENT_BENCH === "after" ? makeEventInterest(`ses_probe_${index}`) : undefined)))
      const client = createOpencodeClient({
        baseUrl: "http://event-probe",
        fetch: Object.assign(async () => response, { preconnect: fetch.preconnect }),
      })
      const events = await client.global.event({ signal: controller.signal, sseMaxRetryAttempts: 0 })
      void (async () => {
        for await (const event of events.stream) {
          counts[index]++
          bytes[index] += Buffer.byteLength(JSON.stringify(event))
          handler(event)
          if (event.payload.type === "server.connected" && ++connected === 2) ready.resolve()
          if (String(event.payload.type) === "server.bench.done") done[index].resolve()
        }
      })()
      return () => controller.abort()
    },
  }))
  const done = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  function Probe() {
    useSDK().interest.select(`ses_probe_${stores.length}`)
    stores.push(useData())
    return <text>event probe</text>
  }
  const app = await testRender(() => <>
    {sources.map((events) => <SDKProvider url="http://event-probe" directory="/project-a" events={events}
      fetch={Object.assign(async (input: RequestInfo | URL) => Response.json(new URL(input instanceof Request ? input.url : String(input)).pathname === "/api/location" ? { directory: "/project-a" } : { data: [], location: { directory: "/project-a" } }), { preconnect: fetch.preconnect })}>
      <DataProvider><Probe /></DataProvider>
    </SDKProvider>)}
  </>, { width: 40, height: 4 })
  await ready.promise
  while (GlobalBus.listenerCount("event") < 2) await new Promise<void>((resolve) => setImmediate(resolve))
  const cpu = process.cpuUsage()
  const start = performance.now()
  const total = 24
  const publish = (session: number, type: string, properties: Record<string, unknown>) => GlobalBus.emit("event", {
    directory: session % 2 ? "/project-a" : "/project-b",
    payload: { type, properties: { sessionID: `ses_probe_${session}`, timestamp: Date.now(), ...properties } },
  })
  for (let session = 0; session < total; session++) {
    publish(session, "session.status", { status: { type: "busy" } })
    publish(session, "session.next.step.started", { assistantMessageID: `msg_${session}`, agent: "build", model: { id: "fake", providerID: "local" } })
    publish(session, "session.next.text.started", { assistantMessageID: `msg_${session}`, textID: `txt_${session}` })
    publish(session, "message.updated", { info: { id: `legacy_${session}`, sessionID: `ses_probe_${session}`, role: "assistant", time: { created: Date.now() } } })
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  for (let delta = 0; delta < 300; delta++) {
    for (let session = 0; session < total; session++) {
      publish(session, "session.next.text.delta", { assistantMessageID: `msg_${session}`, textID: `txt_${session}`, delta: "abcdefgh".repeat(64) })
      publish(session, "message.part.delta", { messageID: `legacy_${session}`, partID: `part_${session}`, field: "text", delta: "abcdefgh".repeat(64) })
      if (session % 4 === 3) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    if (delta % 10 === 0) await Bun.sleep(1)
  }
  for (let session = 0; session < total; session++) {
    publish(session, "session.next.step.ended", { assistantMessageID: `msg_${session}`, cost: 1, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" })
    publish(session, "session.status", { status: { type: "idle" } })
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  GlobalBus.emit("event", { payload: { type: "server.bench.done", properties: {} } })
  await Promise.all(done.map((item) => item.promise))
  await Bun.sleep(50) // Include the production SDK's 16ms batching window.
  const used = process.cpuUsage(cpu)
  const retained = stores.map((store) => Array.from({ length: total }, (_, session) => store.session.message.list(`ses_probe_${session}`)?.[0])
    .filter((message) => message?.type === "assistant")
    .reduce((sum, message) => sum + (message?.type === "assistant" ? message.content.reduce((n, part) => n + (part.type === "text" ? part.text.length : 0), 0) : 0), 0))
  const smaps = await Bun.file(`/proc/${process.pid}/smaps_rollup`).text()
  const result = { arm: process.env.EVENT_BENCH, elapsedMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000,
    counts, bytes, retained, pssKb: Number(smaps.match(/^Pss:\s+(\d+)/m)?.[1]), sessions: total, clients: 2 }
  console.log(JSON.stringify(result))
  if (process.env.EVENT_BENCH_OUT) await Bun.write(process.env.EVENT_BENCH_OUT, JSON.stringify(result, null, 2))
  expect(counts[0]).toBeGreaterThan(0)
  controllers.forEach((controller) => controller.abort())
  app.renderer.destroy()
})

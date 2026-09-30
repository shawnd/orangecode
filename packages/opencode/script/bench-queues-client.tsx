/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { onCleanup } from "solid-js"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { SDKProvider, useSDK } from "../../tui/src/context/sdk"

// Measure the actual SDKProvider injected-source/batching/emitter path. Both
// bundles use this harness; only SDKProvider is replaced with immutable source.
const mode = process.argv[2] ?? "slow"
const count = mode === "slow" ? 2000 : 1000
const size = mode === "slow" ? 65536 : 256
const ready = Promise.withResolvers<void>()
const done = Promise.withResolvers<void>()
const source = { offer: (event: GlobalEvent) => {}, cleanup: 0 }
const latencies: number[] = []
const retained = { events: 0, bytes: 0, maxEvents: 0, maxBytes: 0 }
let received = 0
function Probe() {
  const sdk = useSDK()
  onCleanup(
    sdk.event.on("event", (event) => {
      received++
      retained.events--
      retained.bytes -= Buffer.byteLength(JSON.stringify(event))
      latencies.push(performance.now() - Number(event.payload.id))
      if (received === count) done.resolve()
    }),
  )
  return <box />
}
const app = await testRender(() => (
  <SDKProvider
    url="http://unused"
    events={{
      subscribe: async (offer) => {
        source.offer = offer
        ready.resolve()
        return () => {
          source.cleanup++
        }
      },
    }}
  >
    <Probe />
  </SDKProvider>
))
await ready.promise
const pss = async () =>
  Number((await Bun.file(`/proc/${process.pid}/smaps_rollup`).text()).match(/^Pss:\s+(\d+)/m)?.[1])
const beforePss = await pss()
const cpu = process.cpuUsage()
const start = performance.now()
for (let i = 0; i < count; i++) {
  const event: GlobalEvent = {
    directory: "/queues-fixture",
    payload: {
      id: String(performance.now()),
      type: "message.part.delta",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_test",
        partID: "prt_test",
        field: "text",
        delta: `${i}:` + "x".repeat(size),
      },
    },
  }
  retained.events++
  retained.bytes += Buffer.byteLength(JSON.stringify(event))
  source.offer(event)
  // At a producer boundary, events offered minus events applied is the actual
  // client batch backlog (no helper implementation is simulated here).
  retained.maxEvents = Math.max(retained.maxEvents, retained.events)
  retained.maxBytes = Math.max(retained.maxBytes, retained.bytes)
  if (mode === "normal") await Bun.sleep(1)
}
// Observe the burst before a timer can drain the baseline queue.
const afterBurstPss = await pss()
await done.promise
const elapsed = performance.now() - start
const afterDrainPss = await pss()
const used = process.cpuUsage(cpu)
app.renderer.destroy()
latencies.sort((a, b) => a - b)
console.log(
  JSON.stringify({
    mode,
    count,
    size,
    received,
    beforePssKB: beforePss,
    afterBurstPssKB: afterBurstPss,
    afterDrainPssKB: afterDrainPss,
    maxPendingBytes: retained.maxBytes,
    maxPendingEvents: retained.maxEvents,
    cpuMs: (used.user + used.system) / 1000,
    elapsedMs: elapsed,
    p99Ms: latencies[Math.floor(latencies.length * 0.99)] ?? null,
    sourceCleanup: source.cleanup,
  }),
)

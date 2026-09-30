/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { onCleanup } from "solid-js"
import { SDKProvider, useSDK } from "../../../src/context/sdk"

test("SDK EventSource applies a byte/count-limited burst losslessly, including an oversize delta", async () => {
  const received: GlobalEvent[] = []
  const source = { offer: (event: GlobalEvent) => {}, cleanup: 0 }
  const ready = Promise.withResolvers<void>()
  const done = Promise.withResolvers<void>()
  function Probe() {
    const sdk = useSDK()
    onCleanup(
      sdk.event.on("event", (event) => {
        received.push(event)
        if (event.payload.id === "evt_301") done.resolve()
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
  try {
    await ready.promise
    const events: GlobalEvent[] = Array.from({ length: 302 }, (_, i) => ({
      directory: "/queues-fixture",
      payload: {
        id: `evt_${i}`,
        type: "message.part.delta",
        properties: {
          sessionID: "ses_test",
          messageID: "msg_test",
          partID: "prt_test",
          field: "text",
          delta: i === 300 ? "x".repeat(1024 * 1024 + 1) : `${i},`,
        },
      },
    }))
    events.slice(0, 301).forEach(source.offer)
    // The oversize event forces the entire prefix through without a timer wait.
    expect(received).toEqual(events.slice(0, 301))
    source.offer(events[301])
    await Promise.race([
      done.promise,
      Bun.sleep(1000).then(() => {
        throw new Error("batch did not drain")
      }),
    ])
    expect(received).toEqual(events)
  } finally {
    app.renderer.destroy()
  }
  expect(source.cleanup).toBe(1)
})

test("SDK EventSource detaches when an asynchronous subscription completes after disposal", async () => {
  const subscribed = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<() => void>()
  const source = { cleanup: 0 }
  const app = await testRender(() => (
    <SDKProvider
      url="http://unused"
      events={{
        subscribe: async () => {
          subscribed.resolve()
          return ready.promise
        },
      }}
    >
      <box />
    </SDKProvider>
  ))
  await subscribed.promise
  app.renderer.destroy()
  ready.resolve(() => {
    source.cleanup++
  })
  await ready.promise
  await Promise.resolve()
  expect(source.cleanup).toBe(1)
})

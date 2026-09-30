/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { SDKProvider } from "../../src/context/sdk"

const fetched = Promise.withResolvers<void>()
const request = Object.assign(
  async () => {
    fetched.resolve()
    return new Response("", { headers: { "content-type": "text/event-stream" } })
  },
  { preconnect: fetch.preconnect },
)
const view = await testRender(() => (
  <SDKProvider url="http://test" fetch={request}>
    <box />
  </SDKProvider>
))
await fetched.promise
// An empty in-memory SSE response completes in microtasks. Move to the next
// event-loop turn so the SDK is waiting on reconnect backoff before unmounting.
await new Promise<void>((resolve) => setImmediate(resolve))
view.renderer.destroy()
console.log("retry scope destroyed")

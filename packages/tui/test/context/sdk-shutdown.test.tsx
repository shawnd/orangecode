/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { SDKProvider } from "../../src/context/sdk"
import path from "path"

test("unmount cancels SSE reconnect backoff rather than keeping the process alive", async () => {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../fixture/sdk-retry-exit.tsx")], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = child.stdout.getReader()
  const errors = new Response(child.stderr).text()
  try {
    const ready = (async () => {
      const decoder = new TextDecoder()
      let output = ""
      while (!output.includes("retry scope destroyed")) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error("SDK process exited before cleanup")
        output += decoder.decode(chunk.value, { stream: true })
      }
    })()
    const timeout = Promise.withResolvers<never>()
    const waiting = setTimeout(() => timeout.reject(new Error("SDK cleanup did not start")), 5000)
    await Promise.race([ready, timeout.promise]).finally(() => clearTimeout(waiting))
    const deadline = setTimeout(() => child.kill(), 750)
    const code = await child.exited
    clearTimeout(deadline)
    expect(code, await errors).toBe(0)
  } finally {
    reader.releaseLock()
    if (child.exitCode === null) child.kill()
  }
}, 10_000)

test("a subscription that completes after unmount is released immediately", async () => {
  const installed = Promise.withResolvers<void>()
  const subscription = Promise.withResolvers<() => void>()
  const released = Promise.withResolvers<void>()
  let count = 0
  const view = await testRender(() => (
    <SDKProvider
      url="http://test"
      events={{
        async subscribe() {
          installed.resolve()
          return subscription.promise
        },
      }}
    >
      <box />
    </SDKProvider>
  ))
  await installed.promise
  view.renderer.destroy()
  subscription.resolve(() => {
    count++
    released.resolve()
  })
  await released.promise
  expect(count).toBe(1)
})

test("a completed event subscription is released exactly once on unmount", async () => {
  const installed = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let count = 0
  const view = await testRender(() => (
    <SDKProvider
      url="http://test"
      events={{
        async subscribe() {
          installed.resolve()
          return () => {
            count++
            released.resolve()
          }
        },
      }}
    >
      <box />
    </SDKProvider>
  ))
  await installed.promise
  await view.renderOnce()
  view.renderer.destroy()
  await released.promise
  expect(count).toBe(1)
})

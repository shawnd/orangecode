import { describe, expect, test } from "bun:test"
import { Rpc } from "../../src/util/rpc"
import { withTimeout } from "../../src/util/timeout"
import { type rpc } from "../fixture/rpc-worker"

describe("Worker RPC", () => {
  test("rejects synchronous, asynchronous, non-Error, and result-serialization failures and remains usable", async () => {
    const worker = new Worker(new URL("../fixture/rpc-worker.ts", import.meta.url))
    const client = Rpc.client<typeof rpc>(worker)
    try {
      for (const async of [false, true]) {
        const error = await withTimeout(
          client.call("fail", { async }).catch((error: unknown) => error),
          2000,
        )
        expect(error).toBeInstanceOf(Error)
        expect(error).toMatchObject({ name: "TypeError", message: "worker method failed", code: "RPC_TEST" })
        expect((error as Error).stack).toContain("rpc-worker.ts")
      }
      const plain = await withTimeout(
        client.call("fail", { async: false, value: "plain rejection" }).catch((error: unknown) => error),
        2000,
      )
      expect(plain).toMatchObject({ message: "plain rejection" })
      const circular = await withTimeout(
        client.call("circular", undefined).catch((error: unknown) => error),
        2000,
      )
      expect(circular).toBeInstanceOf(Error)
      const caused = await withTimeout(
        client.call("caused", undefined).catch((error: unknown) => error),
        2000,
      )
      expect(caused).toMatchObject({ message: "outer failure", cause: { message: "bind failed", code: "EADDRINUSE" } })
      const cyclic = await withTimeout(
        client.call("cyclicCause", undefined).catch((error: unknown) => error),
        2000,
      )
      expect(cyclic).toMatchObject({ message: "cyclic cause" })
      expect(await client.call("echo", { value: "still alive" })).toBe("still alive")
    } finally {
      client.dispose()
      await worker.terminate()
    }
  })

  test("keeps typed event listeners, unsubscribes, and disposes pending calls idempotently", async () => {
    const worker = new Worker(new URL("../fixture/rpc-worker.ts", import.meta.url))
    const client = Rpc.client<typeof rpc>(worker)
    const values: string[] = []
    const handler = (value: string) => values.push(value)
    const off = client.on<string>("value", handler)
    client.on<string>("value", handler)
    try {
      await client.call("publish", { value: "first" })
      expect(values).toEqual(["first"])
      off()
      off()
      await client.call("publish", { value: "second" })
      expect(values).toEqual(["first"])
      client.on<string>("value", (value) => values.push(value))
      off()
      await client.call("publish", { value: "third" })
      expect(values).toEqual(["first", "third"])
      const pending = client.call("block", undefined).catch((error: unknown) => error)
      client.dispose()
      client.dispose()
      expect(await pending).toMatchObject({ message: "RPC client closed" })
      await expect(client.call("echo", { value: "closed" })).rejects.toThrow("RPC client closed")
      // A separate real-worker message barrier proves disposal removed the RPC event listener.
      const received = new Promise<void>((resolve) =>
        worker.addEventListener("message", () => resolve(), { once: true }),
      )
      worker.postMessage(
        JSON.stringify({ type: "rpc.request", method: "publish", input: { value: "disposed" }, id: 99 }),
      )
      await withTimeout(received, 2000)
      expect(values).toEqual(["first", "third"])
    } finally {
      client.dispose()
      await worker.terminate()
    }
  })

  test("rejects calls admitted before a worker initialization error", async () => {
    const worker = new Worker(new URL("../fixture/rpc-worker.ts", import.meta.url), {
      env: { RPC_TEST_STARTUP_ERROR: "true" },
    })
    worker.addEventListener("error", (event) => event.preventDefault())
    const client = Rpc.client<typeof rpc>(worker)
    try {
      const results = await withTimeout(
        Promise.allSettled([client.call("echo", { value: "one" }), client.call("echo", { value: "two" })]),
        2000,
      )
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"])
      for (const result of results) {
        if (result.status !== "rejected") throw new Error("Expected RPC rejection")
        expect(result.reason).toBeInstanceOf(Error)
        expect(result.reason.message).toContain("worker initialization failed")
      }
    } finally {
      client.dispose()
      await worker.terminate()
    }
  })

  for (const boundary of ["crash", "close", "terminate"] as const) {
    test(`rejects every pending and future call on worker ${boundary}`, async () => {
      const worker = new Worker(new URL("../fixture/rpc-worker.ts", import.meta.url))
      // Bun reports uncaught worker exceptions to the parent; the RPC error listener also observes this event.
      worker.addEventListener("error", (event) => event.preventDefault())
      const client = Rpc.client<typeof rpc>(worker)
      try {
        await client.call("echo", { value: "ready" })
        const pending = Promise.allSettled([client.call("block", undefined), client.call("block", undefined)])
        if (boundary === "terminate") await worker.terminate()
        if (boundary === "crash") await client.call("crash", undefined)
        if (boundary === "close") void client.call("close", undefined).catch(() => {})
        const results = await withTimeout(pending, 2000)
        expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"])
        for (const result of results) {
          if (result.status !== "rejected") throw new Error("Expected RPC rejection")
          expect(result.reason).toBeInstanceOf(Error)
          expect(result.reason.message).toContain(boundary === "crash" ? "worker crashed" : "Worker closed")
        }
        await expect(client.call("echo", { value: "after failure" })).rejects.toThrow(
          boundary === "crash" ? "worker crashed" : "Worker closed",
        )
      } finally {
        client.dispose()
        await worker.terminate()
      }
    })
  }

  test("a request serialization failure rejects only that call", async () => {
    const worker = new Worker(new URL("../fixture/rpc-worker.ts", import.meta.url))
    const client = Rpc.client<typeof rpc>(worker)
    try {
      const input = { value: "circular", self: {} }
      input.self = input
      await expect(client.call("echo", input)).rejects.toThrow()
      expect(await client.call("echo", { value: "next" })).toBe("next")
    } finally {
      client.dispose()
      await worker.terminate()
    }
  })
})

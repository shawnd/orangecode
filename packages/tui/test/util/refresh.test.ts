import { expect, test } from "bun:test"
import { createRefresh } from "../../src/util/refresh"

test("joins reads and coalesces invalidations into a trailing read without caching results", async () => {
  const refresh = createRefresh()
  const reads = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  let calls = 0
  const load = () => reads[calls++].promise
  const first = refresh("location/model", load)
  expect(refresh("location/model", load)).toBe(first)
  await Promise.resolve()
  expect(calls).toBe(1)
  expect(refresh("location/model", load, true)).toBe(first)
  refresh("location/model", load, true)
  refresh("location/model", load, true)
  reads[0].resolve()
  await reads[0].promise
  await Promise.resolve()
  expect(calls).toBe(2)
  reads[1].resolve()
  await first
  const next = refresh("location/model", load)
  await Promise.resolve()
  expect(calls).toBe(3)
  reads[2].resolve()
  await next
})

test("keeps a new invalidation during the trailing read and isolates keys", async () => {
  const refresh = createRefresh()
  const reads = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  let calls = 0
  const load = () => reads[calls++].promise
  const first = refresh("a/model", load)
  await Promise.resolve()
  refresh("a/model", load, true)
  reads[0].resolve()
  await reads[0].promise
  await Promise.resolve()
  expect(calls).toBe(2)
  refresh("a/model", load, true)
  await refresh("b/model", async () => {})
  await refresh("a/provider", async () => {})
  reads[1].resolve()
  await reads[1].promise
  await Promise.resolve()
  expect(calls).toBe(3)
  reads[2].resolve()
  await first
})

test("retries a dirty failed read and clears rejected requests for later refreshes", async () => {
  const refresh = createRefresh()
  const read = Promise.withResolvers<void>()
  let calls = 0
  const load = () => (++calls === 1 ? read.promise : Promise.resolve())
  const first = refresh("model", load)
  await Promise.resolve()
  refresh("model", load, true)
  read.reject(new Error("stale read failed"))
  await first
  expect(calls).toBe(2)
  await expect(refresh("model", () => Promise.reject(new Error("failed")))).rejects.toThrow("failed")
  await refresh("model", load)
  expect(calls).toBe(3)
})

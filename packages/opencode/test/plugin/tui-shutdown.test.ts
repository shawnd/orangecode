import { expect, test } from "bun:test"
import { TuiPluginRuntime } from "../../src/plugin/tui/runtime"

test("resources registered after plugin disposal are released immediately exactly once", async () => {
  const scope = TuiPluginRuntime.createPluginScope({ spec: "shutdown-test" }, "shutdown-test", 1000)
  let released = 0
  const first = scope.track(() => {
    released++
  })
  await scope.dispose()
  first()
  expect(released).toBe(1)
  const late = scope.track(() => {
    released++
  })
  expect(released).toBe(2)
  late()
  await scope.dispose()
  expect(released).toBe(2)
})

test("concurrent plugin disposals join the same in-flight cleanup", async () => {
  const scope = TuiPluginRuntime.createPluginScope({ spec: "shutdown-test" }, "shutdown-test", 1000)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let count = 0
  scope.lifecycle.onDispose(async () => {
    count++
    entered.resolve()
    await release.promise
  })
  const first = scope.dispose()
  expect(scope.lifecycle.signal.aborted).toBe(true)
  await entered.promise
  const second = scope.dispose()
  expect(second).toBe(first)
  expect(scope.lifecycle.signal.aborted).toBe(true)
  release.resolve()
  await Promise.all([first, second])
  expect(count).toBe(1)
})

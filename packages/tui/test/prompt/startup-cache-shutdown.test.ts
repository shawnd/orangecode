import path from "path"
import { expect, test } from "bun:test"
import { cacheStartupPresentation, flushStartupPresentation } from "../../src/startup/cache"
import { tmpdir } from "../fixture/fixture"

test("shutdown flushes a coalesced startup snapshot before its debounce timer fires", async () => {
  await using tmp = await tmpdir()
  cacheStartupPresentation(tmp.path, { background: "#111111" })
  cacheStartupPresentation(tmp.path, { border: "#222222" })
  await flushStartupPresentation(tmp.path)
  const saved = await Bun.file(path.join(tmp.path, "startup-presentation.json")).json()
  expect(saved.background).toBe("#111111")
  expect(saved.border).toBe("#222222")
})

test("overlapping flushes retain newer updates while an earlier snapshot finishes", async () => {
  await using tmp = await tmpdir()
  cacheStartupPresentation(tmp.path, { background: "#111111" })
  const first = flushStartupPresentation(tmp.path)
  cacheStartupPresentation(tmp.path, { background: "#222222" })
  const second = flushStartupPresentation(tmp.path)
  await first
  cacheStartupPresentation(tmp.path, { border: "#333333" })
  const third = flushStartupPresentation(tmp.path)
  await Promise.all([second, third])
  const saved = await Bun.file(path.join(tmp.path, "startup-presentation.json")).json()
  expect(saved.background).toBe("#222222")
  expect(saved.border).toBe("#333333")
})

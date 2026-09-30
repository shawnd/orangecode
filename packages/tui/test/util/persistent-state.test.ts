import path from "path"
import { expect, test } from "bun:test"
import { Flock } from "@opencode-ai/core/util/flock"
import { createPersistentState } from "../../src/util/persistent-state"
import { missing, readJson, writeJsonAtomic } from "../../src/util/persistence"
import { tmpdir } from "../fixture/fixture"

test("shutdown waits for blocked initial loading and all admitted writes", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "state.json")
  await writeJsonAtomic(file, ["existing"])
  const lease = await Flock.acquire(`tui-state:${path.resolve(file)}`, { dir: path.join(tmp.path, "locks") })
  const errors: unknown[] = []
  const seen: string[][] = []
  const state = createPersistentState({
    file,
    initial: [] as string[],
    read: () => readJson<string[]>(file),
    write: (value) => writeJsonAtomic(file, value),
    onChange: (value) => seen.push(value),
    onError: (error) => errors.push(error),
  })
  const writes = [
    state.update((value) => [...value, "first"]),
    state.update((value) => [...value, "second"]),
    state.update((value) => value.filter((item) => item !== "first")),
  ]
  expect(seen.at(-1)).toEqual(["second"])
  let closed = false
  const closing = state.dispose().then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(closed).toBe(false)
  await lease.release()
  await closing
  expect(await readJson<string[]>(file)).toEqual(["existing", "second"])
  await Promise.all(writes)
  await expect(state.update((value) => [...value, "late"])).rejects.toThrow("closed")
  expect(errors).toEqual([])
})

test("concurrent instances merge updates rather than saving stale whole-file snapshots", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "settings.json")
  await writeJsonAtomic(file, { existing: true })
  const open = () =>
    createPersistentState({
      file,
      initial: {} as Record<string, boolean>,
      read: () => readJson<Record<string, boolean>>(file),
      write: (value) => writeJsonAtomic(file, value),
      onChange() {},
      onError(error) {
        throw error
      },
    })
  const first = open()
  const second = open()
  await Promise.all([first.ready, second.ready])
  await Promise.all([
    first.update((value) => ({ ...value, first: true })),
    second.update((value) => ({ ...value, second: true })),
  ])
  await Promise.all([first.dispose(), second.dispose()])
  expect(await readJson<Record<string, boolean>>(file)).toEqual({ existing: true, first: true, second: true })
})

test("a failed write does not prevent disposal or later repaired writes", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "state.json")
  const errors: unknown[] = []
  const state = createPersistentState({
    file,
    initial: [] as string[],
    read: () =>
      readJson<string[]>(file).catch((error: unknown) => {
        if (missing(error)) return []
        throw error
      }),
    write: (value) => writeJsonAtomic(file, value),
    onChange() {},
    onError: (error) => errors.push(error),
  })
  await state.ready
  await Bun.write(file, "{")
  await expect(state.update((value) => [...value, "failed"])).rejects.toThrow()
  expect(await Bun.file(file).text()).toBe("{")
  await writeJsonAtomic(file, ["restored"])
  const saved = state.update((value) => [...value, "next"])
  await state.dispose()
  await saved
  expect(await readJson<string[]>(file)).toEqual(["restored", "next"])
  expect(errors).toHaveLength(1)
})

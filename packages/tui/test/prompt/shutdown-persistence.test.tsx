/** @jsxImportSource @opentui/solid */
import path from "path"
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { KVProvider, useKV } from "../../src/context/kv"
import { PromptHistoryProvider, parsePromptHistory, usePromptHistory } from "../../src/prompt/history"
import { PromptStashProvider, parsePromptStash, usePromptStash } from "../../src/prompt/stash"
import { FrecencyProvider, parseFrecency, useFrecency } from "../../src/prompt/frecency"
import { readJson, readText, writeJsonAtomic, writeTextAtomic } from "../../src/util/persistence"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"

test("immediate unmount flushes settings, history, stash removals, and file usage without wiping loaded data", async () => {
  await using tmp = await tmpdir()
  const used = path.join(tmp.path, "used.ts")
  await writeJsonAtomic(path.join(tmp.path, "kv.json"), { existing: true })
  await writeTextAtomic(
    path.join(tmp.path, "prompt-history.jsonl"),
    JSON.stringify({ input: "existing", parts: [] }) + "\n",
  )
  await writeTextAtomic(
    path.join(tmp.path, "prompt-stash.jsonl"),
    JSON.stringify({ input: "existing stash", parts: [], timestamp: 1 }) + "\n",
  )
  await writeTextAtomic(
    path.join(tmp.path, "frecency.jsonl"),
    JSON.stringify({ path: used, frequency: 5, lastOpen: 1 }) + "\n",
  )
  const disposals = new Set<Promise<void>>()
  const ready = Promise.withResolvers<{
    kv: ReturnType<typeof useKV>
    history: ReturnType<typeof usePromptHistory>
    stash: ReturnType<typeof usePromptStash>
    frecency: ReturnType<typeof useFrecency>
  }>()
  function Probe() {
    const context = { kv: useKV(), history: usePromptHistory(), stash: usePromptStash(), frecency: useFrecency() }
    onMount(() => ready.resolve(context))
    return <box />
  }
  const view = await testRender(() => (
    <TestTuiContexts directory={tmp.path} paths={{ state: tmp.path }} onDispose={(done) => disposals.add(done)}>
      <KVProvider>
        <PromptHistoryProvider>
          <PromptStashProvider>
            <FrecencyProvider>
              <Probe />
            </FrecencyProvider>
          </PromptStashProvider>
        </PromptHistoryProvider>
      </KVProvider>
    </TestTuiContexts>
  ))
  try {
    const context = await ready.promise
    context.kv.set("first", true)
    context.kv.set("second", true)
    context.kv.set("counter", (value: number | undefined) => (value ?? 0) + 1)
    context.kv.set("counter", (value: number) => value + 1)
    context.history.append({ input: "first", parts: [] })
    context.history.append({ input: "second", parts: [] })
    context.stash.push({ input: "keep", parts: [] })
    context.stash.push({ input: "drop", parts: [] })
    expect(context.stash.pop()?.input).toBe("drop")
    context.stash.remove(context.stash.list().findIndex((entry) => entry.input === "keep"))
    context.frecency.updateFrecency("used.ts")
    context.frecency.updateFrecency("used.ts")
    view.renderer.destroy()
    await Promise.all(disposals)
    expect(await readJson<Record<string, boolean | number>>(path.join(tmp.path, "kv.json"))).toEqual({
      existing: true,
      first: true,
      second: true,
      counter: 2,
    })
    expect(
      parsePromptHistory(await readText(path.join(tmp.path, "prompt-history.jsonl"))).map((entry) => entry.input),
    ).toEqual(["existing", "first", "second"])
    expect(
      parsePromptStash(await readText(path.join(tmp.path, "prompt-stash.jsonl"))).map((entry) => entry.input),
    ).toEqual(["existing stash"])
    expect(parseFrecency(await readText(path.join(tmp.path, "frecency.jsonl")))[0]?.frequency).toBe(7)
  } finally {
    if (!view.renderer.isDestroyed) view.renderer.destroy()
    await Promise.all(disposals)
  }
})

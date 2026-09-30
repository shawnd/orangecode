import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Fff } from "../src/filesystem/fff.bun"
import type { Grep, GrepMatches, Init } from "../src/filesystem/fff-types"
import { Entry, Match } from "@opencode-ai/schema/filesystem"
import { RelativePath } from "../src/schema"
import { FileSystemSearch } from "../src/filesystem/search"
import { FffClient } from "../src/filesystem/fff-client"
import type { Response } from "../src/filesystem/fff-types"
import assert from "node:assert/strict"
import { Schema } from "effect"

const root = path.resolve(import.meta.dir, "../dist/native-search")
const mode = process.argv[2] ?? "run"
const backend = process.argv[3] ?? "worker"
const dataset = process.argv[4] ?? "10000"
const operation = process.argv[5] ?? "grep"
const maxThreads = Number(process.argv[6] ?? 0)
const locations = Number(process.argv[7] ?? 1)
const iterations = Number(process.argv[8] ?? 30)
const decodeMatches = Schema.decodeUnknownSync(Schema.Array(Match))
const isMatches = Schema.is(Schema.Array(Match))

async function materializeExperiment(value: GrepMatches) {
  if (!["decode", "guard"].includes(process.env.SEARCH_MATERIALIZE ?? ""))
    return FileSystemSearch.materializeMatches(value)
  const result: Match[] = []
  for (let offset = 0; offset < value.length; offset += 128) {
    if (offset) await new Promise<void>((resolve) => setImmediate(resolve))
    const batch: unknown = value.slice(offset, offset + 128)
    result.push(...(process.env.SEARCH_MATERIALIZE === "guard" && isMatches(batch) ? batch : decodeMatches(batch)))
  }
  return result
}
const options = (basePath: string): Init => ({
  basePath,
  aiMode: true,
  disableMmapCache: true,
  disableContentIndexing: true,
})
const stats = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  return {
    n: sorted.length,
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted.at(-1),
  }
}

function format(result: Grep): GrepMatches {
  return result.items.map((hit) => {
    const bytes = Buffer.from(hit.lineContent)
    return {
      entry: { path: hit.relativePath.replaceAll("\\", "/"), type: "file" },
      line: hit.lineNumber,
      offset: hit.byteOffset,
      text: hit.lineContent.length > 2000 ? hit.lineContent.slice(0, 2000) + "..." : hit.lineContent,
      submatches: hit.matchRanges.map(([start, end]) => ({
        text: bytes.subarray(start, end).toString("utf8"),
        start,
        end,
      })),
    }
  })
}

async function make(basePath: string) {
  if (backend === "worker" || backend === "facade") {
    const picker = backend === "worker" ? Fff.createWorker(options(basePath)) : Fff.create(options(basePath))
    return {
      wait: async () => {
        if ((await picker.waitForScan(60_000)) !== true) throw new Error("scan not ready")
        return true
      },
      file: () => picker.fileSearch("component", { pageSize: 100, ...{ maxThreads } }),
      grep: () =>
        picker.grepMatches(operation === "payload" ? "needle" : "missing_unique_token_xyz", {
          mode: "regex",
          timeBudgetMs: 1500,
          pageSize: operation === "payload" ? 10000 : 50,
        }),
      destroy: () => picker.destroy(),
      evidence: () => picker.state,
    }
  }
  const { FileFinder } = await import("@ff-labs/fff-bun")
  const result = FileFinder.create(options(basePath))
  if (!result.ok) throw new Error(result.error)
  const picker = result.value
  return {
    wait: async () => {
      const result = await picker.waitForScan(60_000)
      if (!result.ok) throw new Error(result.error)
      if (result.value !== true) throw new Error("scan not ready")
      return true
    },
    file: () => {
      const result = picker.fileSearch("component", { pageSize: 100, maxThreads })
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    grep: () => {
      const result = picker.grep(operation === "payload" ? "needle" : "missing_unique_token_xyz", {
        mode: "regex",
        timeBudgetMs: 1500,
        pageSize: operation === "payload" ? 10000 : 50,
      })
      if (!result.ok) throw new Error(result.error)
      return format(result.value)
    },
    destroy: async () => picker.destroy(),
    evidence: () => ({ backend: "fff-direct", destroyed: picker.isDestroyed }),
  }
}

// Benchmark-only adapter around the frozen production worker and scheduler.
// Every codec candidate lives under ignored dist; no production protocol edits.
async function transferExperiment(basePath: string) {
  if (
    !["clone", "json", "json-string", "jsc-shared", "jsc-transfer", "tuples", "jsc-tuples", "json-tuples"].includes(
      backend,
    )
  )
    throw new Error("unknown codec")
  const entry = path.join(root, `experiment-${backend}.worker.mjs`)
  await Bun.write(
    entry,
    `
    import { serialize } from "bun:jsc"
    const codec = ${JSON.stringify(backend)}
    const post = self.postMessage.bind(self)
    const pending = []
    self.onmessage = event => pending.push(event)
    await import(${JSON.stringify(new URL("../src/filesystem/fff.worker.ts", import.meta.url).href)})
    const handle = self.onmessage
    const starts = new Map()
    let verify = true
    self.postMessage = response => {
      if (!response.ok || !Array.isArray(response.value)) { post(response); return }
      const nativeMs = performance.now() - (starts.get(response.id) ?? performance.now())
      const digest = verify && response.id > 0 ? Bun.hash(JSON.stringify(response.value)).toString() : undefined
      if (verify && response.id > 0) post({ benchmark: "oracle", oracle: response.value })
      if (response.id > 0) verify = false
      const start = performance.now()
      let wire = response
      let transfer = []
      let bytes
      const tuples = codec.endsWith("tuples") ? response.value.map(match => [match.entry.path, match.line, match.offset, match.text,
        ...match.submatches.flatMap(hit => [hit.text, hit.start, hit.end])]) : undefined
      if (codec === "tuples") wire = { id: response.id, ok: true, codec, tuples }
      if (codec === "json" || codec === "json-tuples") {
        const buffer = new TextEncoder().encode(JSON.stringify(tuples ?? response.value)).buffer
        bytes = buffer.byteLength
        wire = { id: response.id, ok: true, codec, buffer }
        transfer = [buffer]
      }
      if (codec === "json-string") {
        const text = JSON.stringify(response.value)
        bytes = text.length * 2
        wire = { id: response.id, ok: true, codec, text }
      }
      if (codec === "jsc-shared" || codec === "jsc-transfer" || codec === "jsc-tuples") {
        const serialized = serialize(tuples ?? response.value)
        const buffer = codec === "jsc-shared" ? serialized : new Uint8Array(serialized).slice().buffer
        bytes = buffer.byteLength
        wire = { id: response.id, ok: true, codec, buffer }
        if (codec !== "jsc-shared") transfer = [buffer]
      }
      wire.metrics = { nativeMs, encodeMs: performance.now() - start, bytes, digest,
        sent: performance.timeOrigin + performance.now() }
      post(wire, transfer)
    }
    self.onmessage = event => {
      if (event.data.benchmark === "roundtrip") {
        self.postMessage({id: -1, ok: true, value: event.data.value})
        return
      }
      starts.set(event.data.id, performance.now())
      return handle(event)
    }
    pending.forEach(event => self.onmessage(event))
  `,
  )
  const { deserialize } = await import("bun:jsc")
  const metrics: Array<{ nativeMs: number; encodeMs: number; decodeMs: number; deliveryMs: number; bytes?: number }> =
    []
  const roundtrip = Promise.withResolvers<unknown>()
  let native: Worker | undefined
  let nativeParity = false
  let oracle: unknown
  const client = new FffClient(options(basePath), () => {
    const worker = new Worker(entry)
    native = worker
    let listener: ((event: MessageEvent<Response>) => void) | null = null
    Object.defineProperty(worker, "onmessage", {
      get: () => listener,
      set: (next: typeof listener) => {
        listener = next
      },
    })
    worker.addEventListener(
      "message",
      (
        event: MessageEvent<
          Response & {
            codec?: string
            buffer?: ArrayBuffer
            text?: string
            tuples?: unknown
            benchmark?: string
            oracle?: unknown
            metrics?: { nativeMs: number; encodeMs: number; bytes?: number; sent: number; digest?: string }
          }
        >,
      ) => {
        const packet = event.data
        if (packet.benchmark === "oracle") {
          oracle = packet.oracle
          return
        }
        const received = performance.timeOrigin + performance.now()
        const start = performance.now()
        const decoded: unknown =
          packet.codec?.startsWith("json") && packet.buffer
            ? JSON.parse(new TextDecoder().decode(packet.buffer))
            : packet.codec === "json-string" && packet.text !== undefined
              ? JSON.parse(packet.text)
              : packet.codec?.startsWith("jsc-") && packet.buffer
                ? deserialize(packet.buffer)
                : packet.codec === "tuples"
                  ? packet.tuples
                  : packet.ok
                    ? packet.value
                    : undefined
        // Experimental tuple DTO: fixed path/line/offset/text prefix, then ordered
        // text/start/end triples. All input fields come from the frozen worker.
        const value =
          packet.codec?.endsWith("tuples") && Array.isArray(decoded)
            ? (decoded as Array<[string, number, number, string, ...(string | number)[]]>).map((row) => ({
                entry: { path: row[0], type: "file" },
                line: row[1],
                offset: row[2],
                text: row[3],
                submatches: Array.from({ length: (row.length - 4) / 3 }, (_, index) => ({
                  text: row[4 + index * 3],
                  start: row[5 + index * 3],
                  end: row[6 + index * 3],
                })),
              }))
            : decoded
        if (packet.metrics)
          metrics.push({
            ...packet.metrics,
            decodeMs: performance.now() - start,
            deliveryMs: received - packet.metrics.sent,
          })
        if (packet.metrics?.digest) {
          assert.equal(Bun.hash(JSON.stringify(value)).toString(), packet.metrics.digest)
          assert.deepEqual(value, oracle)
          oracle = undefined
          nativeParity = true
        }
        if (packet.id === -1) {
          roundtrip.resolve(value)
          return
        }
        // This boundary receives only this experiment's own encoded DTOs. Full
        // native-page hash parity and string-edge roundtrip parity are checked.
        listener?.(new MessageEvent("message", { data: packet.codec ? { id: packet.id, ok: true, value } : packet }))
      },
    )
    return worker
  })
  return {
    client,
    metrics,
    parity: async () => {
      if (!native) throw new Error("experiment not initialized")
      const texts = [
        "",
        "é🙂 before needle",
        "\ud800",
        "\udfff",
        "x".repeat(1999) + "\ud83d...",
        "\ufeff\0\r\n\t",
        "e\u0301",
        '"quoted"\\path',
      ]
      const fixture = texts.map((text, index) => ({
        entry: { path: `space ü/${index}.ts`, type: "file" },
        line: index + 1,
        offset: index * 1000,
        text,
        submatches: [{ text, start: 0, end: Buffer.byteLength(text) }],
      }))
      fixture.push({
        entry: { path: "multi/界.ts", type: "file" },
        line: 2 ** 31 + 1,
        offset: 2 ** 40,
        text: "x".repeat(1999) + "\ud83d...",
        submatches: [
          { text: "needle", start: 3000, end: 3006 },
          { text: "é🙂", start: 7, end: 13 },
        ],
      })
      fixture.push({ entry: { path: "empty.ts", type: "file" }, line: 1, offset: 0, text: "", submatches: [] })
      native.ref()
      native.postMessage({ benchmark: "roundtrip", value: fixture })
      assert.deepEqual(await roundtrip.promise, fixture)
      native.unref()
      assert.equal(nativeParity, true)
    },
  }
}

if (mode !== "smoke") await fs.mkdir(root, { recursive: true })
const directory = dataset === "repo" ? path.resolve(import.meta.dir, "../../..") : path.join(root, `data-${dataset}`)

if (mode === "smoke") {
  // Reusable source/compiled entry; no adjacent build tree or output directory
  // is needed. The parent supplies only a directory containing smoke.txt.
  const picker = Fff.createWorker(options(path.resolve(process.argv[3])))
  try {
    assert.equal(await picker.waitForScan(5000), true)
    assert.ok((await picker.fileSearch("smoke.txt")).items.some((item) => item.relativePath === "smoke.txt"))
    const matches = await picker.grepMatches("native_worker_needle", {
      mode: "regex",
      pageSize: 10,
      timeBudgetMs: 1500,
    })
    assert.ok(
      matches.some(
        (match) =>
          match.entry.path === "smoke.txt" && match.submatches.some((hit) => hit.text === "native_worker_needle"),
      ),
    )
    assert.equal(picker.state.backend, "fff-worker")
    if (process.env.SEARCH_SMOKE_COMPILED === "1") assert.match(picker.state.workerPath ?? "", /\$bunfs|B:\/~BUN/)
  } finally {
    await picker.destroy()
  }
  assert.equal(picker.state.destroyed, true)
  assert.equal(picker.state.started, false)
  console.log(JSON.stringify({ marker: "FFF_WORKER_SMOKE_OK", ...picker.state }))
} else if (mode === "prepare") {
  if (!/^\d+u?$/.test(dataset)) throw new Error("prepare requires a synthetic file count (optional u for unique lines)")
  const count = Number.parseInt(dataset, 10)
  await fs.rm(directory, { recursive: true, force: true })
  await fs.mkdir(directory, { recursive: true })
  if ((await Bun.spawn(["git", "init", "-q", directory]).exited) !== 0) throw new Error("git init failed")
  const content = "é🙂 needle " + "source code ".repeat(90) + "\n"
  for (let batch = 0; batch < count; batch += 200) {
    await Promise.all(
      Array.from({ length: Math.min(200, count - batch) }, (_, j) => {
        const i = batch + j
        return Bun.write(
          path.join(directory, `src/group-${Math.floor(i / 100)}/component-${i}.txt`),
          dataset.endsWith("u") ? `${String(i).padStart(6, "0")} ${content}` : content,
        )
      }),
    )
  }
  console.log(
    JSON.stringify({
      directory,
      files: count,
      bytesPerFile: Buffer.byteLength(content) + (dataset.endsWith("u") ? 7 : 0),
      seed: dataset.endsWith("u") ? "sequential-v1-unique" : "sequential-v1",
    }),
  )
} else if (mode === "cold") {
  const start = performance.now()
  const picker = await make(directory)
  const initial = await picker.file()
  const partialQueryMs = performance.now() - start
  await picker.wait()
  const readyMs = performance.now() - start
  await picker.destroy()
  console.log(
    JSON.stringify({
      mode,
      backend,
      dataset,
      partialQueryMs,
      initialCount: initial.items.length,
      readyMs,
      evidence: picker.evidence(),
      maxRSS: process.resourceUsage().maxRSS,
    }),
  )
} else if (mode === "allocations") {
  const paths = Array.from({ length: Number(dataset) }, (_, i) => `src/group-${Math.floor(i / 10)}/component-${i}.ts`)
  const times: number[] = []
  let copied = 0
  for (let round = 0; round < iterations + 2; round++) {
    const directories = new Set<string>()
    let view: string[] = []
    const start = performance.now()
    for (const file of paths) {
      const parts = file.split("/")
      parts.slice(0, -1).forEach((_, index) => directories.add(parts.slice(0, index + 1).join("/") + path.sep))
      if (backend === "baseline") {
        view = Array.from(directories)
        if (round === 2) copied += view.length
      }
    }
    if (backend !== "baseline") {
      view = Array.from(directories)
      if (round === 2) copied += view.length
    }
    if (round >= 2) times.push(performance.now() - start)
    if (view.length !== Number(dataset) / 10 + 1) throw new Error("directory parity failed")
  }
  console.log(
    JSON.stringify({
      mode,
      backend,
      dataset,
      iterations,
      ms: stats(times),
      copiedReferences: copied,
      maxRSS: process.resourceUsage().maxRSS,
    }),
  )
} else if (mode === "transfer" && backend !== "direct") {
  const experiment = await transferExperiment(directory)
  if ((await experiment.client.waitForScan(60_000)) !== true) throw new Error("scan not ready")
  const first = await experiment.client.grepMatches("needle", { mode: "regex", timeBudgetMs: 1500, pageSize: 10000 })
  await experiment.parity()
  assert.deepEqual(await materializeExperiment(first), await FileSystemSearch.materializeMatches(first))
  for (const invalid of [
    { ...first[0], line: 0 },
    { ...first[0], offset: -1 },
    { ...first[0], offset: Infinity },
  ]) {
    await assert.rejects(materializeExperiment([invalid]))
    await assert.rejects(FileSystemSearch.materializeMatches([invalid]))
  }
  const payloadBytes = Buffer.byteLength(JSON.stringify(first))
  const delay: number[] = []
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    delay.push(Math.max(0, now - last - 1))
    last = now
  }, 1)
  const latency: number[] = []
  const materialize: number[] = []
  for (let i = 0; i < iterations + 4; i++) {
    const start = performance.now()
    const value = await experiment.client.grepMatches("needle", { mode: "regex", timeBudgetMs: 1500, pageSize: 10000 })
    const decode = performance.now()
    await materializeExperiment(value)
    materialize.push(performance.now() - decode)
    latency.push(performance.now() - start)
    await Bun.sleep(1)
    if (i === 3) {
      latency.length = 0
      materialize.length = 0
      delay.length = 0
      experiment.metrics.length = 0
    }
  }
  clearInterval(timer)
  await experiment.client.destroy()
  assert.equal(experiment.client.state.destroyed, true)
  assert.equal(experiment.metrics.length, iterations)
  console.log(
    JSON.stringify({
      mode,
      backend,
      dataset,
      iterations,
      materialization: process.env.SEARCH_MATERIALIZE ?? "original",
      parity: true,
      matches: first.length,
      payloadBytes,
      latencyMs: stats(latency),
      materializeMs: stats(materialize),
      callerLagMs: stats(delay),
      nativeAndFormatMs: stats(experiment.metrics.map((m) => m.nativeMs)),
      encodeMs: stats(experiment.metrics.map((m) => m.encodeMs)),
      decodeMs: stats(experiment.metrics.map((m) => m.decodeMs)),
      deliveryMs: stats(experiment.metrics.map((m) => m.deliveryMs)),
      encodedBytes: experiment.metrics[0]?.bytes,
      rss: process.memoryUsage().rss,
      maxRSS: process.resourceUsage().maxRSS,
      evidence: experiment.client.state,
    }),
  )
} else if (mode === "memory" || mode === "bounded") {
  // An external process watches RSS/time even while the measured caller is
  // blocked in native code. Limits apply to this experiment, never production.
  const ceiling = Number(process.env.SEARCH_RSS_MB ?? 1536) * 1024 * 1024
  const seconds = Number(process.env.SEARCH_SECONDS ?? 120)
  const command = mode === "memory" ? ["memory-child", ...process.argv.slice(3)] : process.argv.slice(3)
  const child = Bun.spawn([process.execPath, import.meta.filename, ...command], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  const started = performance.now()
  let maximum = 0
  let stopped: string | undefined
  const watchdog = setInterval(async () => {
    const status = await Bun.file(`/proc/${child.pid}/status`)
      .text()
      .catch(() => "")
    const rss = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024
    maximum = Math.max(maximum, rss)
    if (stopped) return
    if (rss <= ceiling && performance.now() - started <= seconds * 1000) return
    stopped = rss > ceiling ? "rss-ceiling" : "time-ceiling"
    child.kill("SIGKILL")
  }, 25)
  const result = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => clearInterval(watchdog))
  if (result[0].trim()) console.log(result[0].trim())
  if (result[1].trim()) console.error(result[1].trim())
  console.log(
    JSON.stringify({
      supervisor: true,
      mode: command[0],
      backend: command[1],
      dataset: command[2],
      maximum,
      ceiling,
      seconds,
      stopped,
      exit: result[2],
    }),
  )
  if (result[2] !== 0) process.exitCode = result[2]
} else if (mode === "memory-child") {
  const { dlopen, FFIType } = await import("bun:ffi")
  // glibc diagnostic only. fff 0.9.4 imports glibc malloc/free on this target.
  const libc = dlopen("libc.so.6", { malloc_trim: { args: [FFIType.u64], returns: FFIType.i32 } })
  const limit = Number(process.env.SEARCH_RSS_MB ?? 1536) * 1024 * 1024
  const seconds = Number(process.env.SEARCH_SECONDS ?? 120)
  const gc = process.env.SEARCH_GC !== "off"
  const trim = process.env.SEARCH_TRIM === "1"
  const pause = Number(process.env.SEARCH_IDLE_MS ?? 25)
  const started = performance.now()
  const rows: Array<{
    cycle: number
    idle: number
    active: number
    closed: number
    gc: number
    trimmed: number
    threads: number
  }> = []
  const cycle = async () => {
    const picker = await make(directory)
    try {
      await picker.wait()
      const idle = process.memoryUsage().rss
      if (operation !== "none") await (operation === "file" ? picker.file() : picker.grep())
      const active = process.memoryUsage().rss
      await picker.destroy()
      if (!picker.evidence().destroyed) throw new Error("native destruction not acknowledged")
      return { idle, active }
    } finally {
      await picker.destroy()
    }
  }
  for (let i = 0; i < iterations; i++) {
    if (process.memoryUsage().rss > limit || performance.now() - started > (seconds - 8) * 1000) break
    const result = await cycle()
    await Bun.sleep(pause)
    const closed = process.memoryUsage().rss
    if (gc) Bun.gc(true)
    const collected = process.memoryUsage().rss
    if (trim) libc.symbols.malloc_trim(0n)
    const status = await Bun.file("/proc/self/status").text()
    const row = {
      cycle: i + 1,
      ...result,
      closed,
      gc: collected,
      trimmed: process.memoryUsage().rss,
      threads: Number(status.match(/^Threads:\s+(\d+)/m)?.[1] ?? 0),
    }
    rows.push(row)
    if ((i + 1) % 25 === 0) console.log(JSON.stringify({ checkpoint: true, backend, dataset, gc, trim, row }))
  }
  const beforeIdle = process.memoryUsage().rss
  await Bun.sleep(5000)
  const afterIdle = process.memoryUsage().rss
  Bun.gc(true)
  const afterGC = process.memoryUsage().rss
  const trimResult = libc.symbols.malloc_trim(0n)
  await Bun.sleep(100)
  const afterTrim = process.memoryUsage().rss
  const slope = (values: number[]) => {
    const center = (values.length - 1) / 2
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    return (
      values.reduce((sum, value, index) => sum + (index - center) * (value - mean), 0) /
      values.reduce((sum, _, index) => sum + (index - center) ** 2, 0)
    )
  }
  const result = {
    mode,
    backend,
    dataset,
    operation,
    requested: iterations,
    completed: rows.length,
    gc,
    trim,
    pause,
    milliseconds: performance.now() - started,
    maxRSS: process.resourceUsage().maxRSS,
    beforeIdle,
    afterIdle,
    afterGC,
    afterTrim,
    trimResult,
    last50: stats(rows.slice(-50).map((row) => row.trimmed)),
    last50SlopeBytesPerCycle: slope(rows.slice(-50).map((row) => row.trimmed)),
    last100SlopeBytesPerCycle: slope(rows.slice(-100).map((row) => row.trimmed)),
    rows,
  }
  const series = path.join(root, `memory-${backend}-${dataset}-${operation}-${gc}-${trim}-${Date.now()}.json`)
  await Bun.write(series, JSON.stringify(result))
  console.log(JSON.stringify({ ...result, rows: undefined, series }))
} else if (mode === "cancel" || mode === "cycles") {
  const settlements: number[] = []
  const idleRSS: number[] = []
  const activeRSS: number[] = []
  const closedRSS: number[] = []
  for (let i = 0; i < iterations; i++) {
    if (backend === "direct") {
      const picker = await make(directory)
      await picker.wait()
      idleRSS.push(process.memoryUsage().rss)
      await picker.grep()
      activeRSS.push(process.memoryUsage().rss)
      await picker.destroy()
      await Bun.sleep(10)
      Bun.gc(true)
      closedRSS.push(process.memoryUsage().rss)
      continue
    }
    const picker = Fff.createWorker(options(directory))
    if ((await picker.waitForScan(60_000)) !== true) throw new Error("scan not ready")
    idleRSS.push(process.memoryUsage().rss)
    const abort = new AbortController()
    const reason = new Error("benchmark explicit abort")
    const pending = picker.grep("missing_unique_token_xyz", { mode: "regex", timeBudgetMs: 1500 }, abort.signal).then(
      () => {
        throw new Error("query delivered after abort")
      },
      (error: unknown) => {
        if (error !== reason) throw error
        return performance.now()
      },
    )
    // Allow the real FFI operation to start before cancelling its caller.
    await Bun.sleep(5)
    activeRSS.push(process.memoryUsage().rss)
    const start = performance.now()
    abort.abort(reason)
    settlements.push((await pending) - start)
    await picker.destroy()
    if (!picker.state.destroyed || picker.state.started) throw new Error("native disposal was not acknowledged")
    await Bun.sleep(10)
    Bun.gc(true)
    closedRSS.push(process.memoryUsage().rss)
  }
  console.log(
    JSON.stringify({
      mode,
      dataset,
      iterations,
      cancellationMs: stats(settlements),
      idleRSS,
      activeRSS,
      closedRSS,
      maxRSS: process.resourceUsage().maxRSS,
    }),
  )
} else {
  const delay: number[] = []
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    delay.push(Math.max(0, now - last - 1))
    last = now
  }, 1)
  const begin = performance.now()
  const pickers = await Promise.all(Array.from({ length: locations }, () => make(directory)))
  const createMs = performance.now() - begin
  if (!(await Promise.all(pickers.map((p) => p.wait()))).every((ready) => ready === true))
    throw new Error("scan not ready")
  const readyMs = performance.now() - begin
  const idleRSS = process.memoryUsage().rss
  const latency: number[] = []
  const materialize: number[] = []
  let payloadBytes = 0
  const query = async () => {
    await Promise.all(
      pickers.map(async (picker) => {
        const start = performance.now()
        const value = operation === "file" ? await picker.file() : await picker.grep()
        const before = performance.now()
        if (Array.isArray(value)) {
          if (
            backend === "worker" ||
            backend === "facade" ||
            ["decode", "guard"].includes(process.env.SEARCH_MATERIALIZE ?? "")
          )
            await materializeExperiment(value)
          else
            value.map((match) =>
              Match.make({
                ...match,
                entry: Entry.make({ ...match.entry, path: RelativePath.make(match.entry.path) }),
              }),
            )
        }
        materialize.push(performance.now() - before)
        latency.push(performance.now() - start)
        if (!payloadBytes) payloadBytes = Buffer.byteLength(JSON.stringify(value))
      }),
    )
    await Bun.sleep(1)
  }
  await query()
  const firstMs = latency[0]
  for (let i = 0; i < 3; i++) await query()
  latency.length = 0
  delay.length = 0
  materialize.length = 0
  for (let i = 0; i < iterations; i++) await query()
  const activeRSS = process.memoryUsage().rss
  clearInterval(timer)
  await Promise.all(pickers.map((p) => p.destroy()))
  console.log(
    JSON.stringify({
      mode,
      backend,
      dataset,
      operation,
      maxThreads,
      locations,
      iterations,
      warmup: 4,
      materialization: process.env.SEARCH_MATERIALIZE ?? "original",
      evidence: pickers.map((picker) => picker.evidence()),
      bun: Bun.version,
      cpu: os.cpus()[0]?.model,
      createMs,
      readyMs,
      firstMs,
      latencyMs: stats(latency),
      callerLagMs: stats(delay),
      materializeMs: stats(materialize),
      payloadBytes,
      idleRSS,
      activeRSS,
      maxRSS: process.resourceUsage().maxRSS,
    }),
  )
}

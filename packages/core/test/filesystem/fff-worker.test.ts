import { describe, expect, test } from "bun:test"
import { FileFinder } from "@ff-labs/fff-bun"
import { Fff } from "../../src/filesystem/fff.bun"
import { FffClient } from "../../src/filesystem/fff-client"
import { FffPool } from "../../src/filesystem/fff-pool"
import { FffError } from "../../src/filesystem/fff-types"
import { FileSystemSearch } from "../../src/filesystem/search"
import { tmpdir } from "../fixture/tmpdir"
import { Effect, Exit, Fiber, Layer } from "effect"
import { LayerNode } from "../../src/effect/layer-node"
import { FSUtil } from "../../src/fs-util"
import { Ripgrep } from "../../src/ripgrep"
import { Location } from "../../src/location"
import { AbsolutePath } from "../../src/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const options = (basePath: string) => ({ basePath, aiMode: true, disableMmapCache: true, disableContentIndexing: true })

async function fixture() {
  const tmp = await tmpdir()
  expect(await Bun.spawn(["git", "init", "-q", tmp.path]).exited).toBe(0)
  await Promise.all(
    Object.entries({
      "src/space ünicode.ts": "é🙂 needle needle\r\n" + "界".repeat(2100) + " needle\n",
      "src/search.ts": "needle\n".repeat(400),
      "src/search.txt": "needle other\n",
      "src/sub/search.ts": "other needle\n",
      ".hidden.ts": "needle\n",
      ".gitignore": "ignored/\n",
      "ignored/skip.ts": "needle\n",
    }).map(([name, text]) => Bun.write(`${tmp.path}/${name}`, text)),
  )
  return tmp
}

// Real worker/native implementation, with test-only gates around request/result
// delivery. No FileFinder method or native result is mocked. Gates make the
// scheduler states deterministic without pretending to pause synchronous FFI.
async function harness(directory: string, holdInit = false) {
  const entry = `${directory}/gate-worker.ts`
  const marker = `${directory}/cleanup.jsonl`
  await Bun.write(
    entry,
    `
    import { appendFileSync } from "node:fs"
    const marker = ${JSON.stringify(marker)}
    const post = self.postMessage.bind(self)
    const ready = Promise.withResolvers()
    const operations = new Map()
    let releaseInit
    let heldGrep
    let holdInit = ${holdInit}
    const gate = new Promise(resolve => { releaseInit = resolve })
    self.postMessage = response => {
      const op = operations.get(response.id)
      if (response.ok && (op === "init" || op === "dispose")) {
        appendFileSync(marker, JSON.stringify({ op, ...response.value }) + "\\n")
      }
      if (op === "grep") {
        heldGrep = response
        post({ test: "grep-result-held" })
        return
      }
      post(response)
    }
    const dispatch = async event => {
      if (event.data.test === "release-init") { holdInit = false; releaseInit(); return }
      if (event.data.test === "release-grep") { const result = heldGrep; heldGrep = undefined; post(result); return }
      if (event.data.test === "exit") { process.exit(0); return }
      if (event.data.test === "error") { queueMicrotask(() => { throw new Error("test worker failure") }); return }
      const request = event.data
      if (request.op === "init" && holdInit) { post({ test: "init-held" }); await gate }
      operations.set(request.id, request.op)
      const handle = await ready.promise
      return handle(event)
    }
    self.onmessage = dispatch
    await import(${JSON.stringify(new URL("../../src/filesystem/fff.worker.ts", import.meta.url).href)})
    const handle = self.onmessage
    self.onmessage = dispatch
    ready.resolve(handle)
  `,
  )
  let native: Worker | undefined
  const signals = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  const signal = (name: string) => {
    const existing = signals.get(name)
    if (existing) return existing
    const next = Promise.withResolvers<void>()
    signals.set(name, next)
    return next
  }
  const client = new FffClient(options(directory), () => {
    const worker = new Worker(entry)
    native = worker
    worker.addEventListener("message", (event: MessageEvent<{ test?: string }>) => {
      if (event.data.test) signal(event.data.test).resolve()
    })
    return worker
  })
  return {
    client,
    entry,
    marker,
    wait: (name: string) => signal(name).promise,
    command: (test: string) => {
      if (!native) throw new Error("worker not started")
      native.postMessage({ test })
    },
  }
}

const scoped = testEffect(Layer.mergeAll(LayerNode.compile(FSUtil.node), LayerNode.compile(Ripgrep.node)))

const withHarness = <A, E, R>(
  holdInit: boolean,
  run: (value: Awaited<ReturnType<typeof harness>>) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireRelease(Effect.promise(fixture), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        const gate = yield* Effect.promise(() => harness(tmp.path, holdInit))
        return yield* run(gate).pipe(
          Effect.provideService(Location.Service, location({ directory: AbsolutePath.make(tmp.path) })),
        )
      }),
    ),
  )

const withDirect = <A, E, R>(run: (picker: ReturnType<typeof Fff.createDirect>) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(Effect.promise(fixture), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
    Effect.flatMap((tmp) =>
      run(Fff.createDirect(options(tmp.path))).pipe(
        Effect.provideService(Location.Service, location({ directory: AbsolutePath.make(tmp.path) })),
      ),
    ),
  )

describe("fff source worker", () => {
  scoped.live("idle lease pins real initialization and destroys a cancelled late-created picker", () =>
    withHarness(true, (gate) =>
      Effect.gen(function* () {
        const service = yield* FileSystemSearch.makeIdle(
          FileSystemSearch.makeFff(() => gate.client),
          30,
        )
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (gate.client.state.started) gate.command("release-init")
          }),
        )
        const first = yield* service.find({ query: "search" }).pipe(Effect.forkScoped)
        const second = yield* service.find({ query: "space" }).pipe(Effect.forkScoped)
        yield* Effect.promise(() => gate.wait("init-held"))
        yield* Fiber.interrupt(first)
        yield* Effect.sleep(100)
        expect(gate.client.state).toMatchObject({ active: "init", closing: false })
        yield* Fiber.interrupt(second)
        yield* Effect.sleep(100)
        expect(gate.client.state).toMatchObject({ active: "init", closing: true, started: true })
        gate.command("release-init")
        yield* Effect.promise(() => gate.client.destroy())
        expect(gate.client.state).toMatchObject({ started: false, destroyed: true })
        const events = (yield* Effect.promise(() => Bun.file(gate.marker).text()))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        expect(events.map((event) => event.op)).toEqual(["init", "dispose"])
        expect(events[1].destroyed).toBe(true)
      }),
    ),
  )

  scoped.live("idle lease protects held native grep delivery through materialization", () =>
    withHarness(false, (gate) =>
      Effect.gen(function* () {
        const service = yield* FileSystemSearch.makeIdle(
          FileSystemSearch.makeFff(() => gate.client),
          30,
        )
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (gate.client.state.active === "grep") gate.command("release-grep")
          }),
        )
        expect(yield* Effect.promise(() => gate.client.waitForScan(5000))).toBe(true)
        const query = yield* service.grep({ pattern: "needle", limit: 1000 }).pipe(Effect.forkScoped)
        yield* Effect.promise(() => gate.wait("grep-result-held"))
        yield* Effect.sleep(100)
        expect(gate.client.state.closing).toBe(false)
        gate.command("release-grep")
        expect((yield* Fiber.join(query)).length).toBeGreaterThan(128)
        yield* Effect.sleep(150)
        expect(gate.client.state).toMatchObject({ started: false, destroyed: true })
      }),
    ),
  )

  test("lazy startup, exact direct parity, raw page/cursor/regex behavior and worker formatting", async () => {
    await using tmp = await fixture()
    const direct = FileFinder.create(options(tmp.path))
    if (!direct.ok) throw new Error(direct.error)
    const worker = Fff.createWorker(options(tmp.path))
    const facade = Fff.createDirect(options(tmp.path))
    expect(worker.state.started).toBe(false)
    try {
      expect(await direct.value.waitForScan(5000)).toEqual({ ok: true, value: true })
      expect(await worker.waitForScan(5000)).toBe(true)
      expect(await facade.waitForScan(5000)).toBe(true)
      expect(facade.state.backend).toBe("fff-direct")
      for (const method of ["fileSearch", "directorySearch", "mixedSearch", "glob"] as const) {
        for (const query of method === "glob"
          ? ["**/*.ts", "src/**", ".*", "ignored/**"]
          : ["", "search", "src/", "space ü"]) {
          for (const pageSize of [undefined, 1, 3, 50]) {
            const input = { pageIndex: 0, pageSize }
            const baseline = direct.value[method](query, input)
            if (!baseline.ok) throw new Error(baseline.error)
            expect(await worker[method](query, input)).toEqual(baseline.value)
            expect(await facade[method](query, input)).toEqual(baseline.value)
          }
        }
      }
      for (const query of ["needle", "src/** *.ts needle", "[", "é🙂", "界", "absent"]) {
        for (const pageSize of [undefined, 1, 50, 1000]) {
          const input = { mode: "regex" as const, pageSize, timeBudgetMs: 1500 }
          const baseline = direct.value.grep(query, input)
          if (!baseline.ok) {
            await expect(worker.grep(query, input)).rejects.toMatchObject({ kind: "query", message: baseline.error })
            await expect(facade.grep(query, input)).rejects.toMatchObject({ kind: "query", message: baseline.error })
            continue
          }
          expect(await worker.grep(query, input)).toEqual(baseline.value)
          expect(await facade.grep(query, input)).toEqual(baseline.value)
          const formatted = await worker.grepMatches(query, input)
          expect(await facade.grepMatches(query, input)).toEqual(formatted)
          expect(formatted).toEqual(
            baseline.value.items.map((hit) => ({
              entry: { path: hit.relativePath.replaceAll("\\", "/"), type: "file" },
              line: hit.lineNumber,
              offset: hit.byteOffset,
              text: hit.lineContent.length > 2000 ? hit.lineContent.slice(0, 2000) + "..." : hit.lineContent,
              submatches: hit.matchRanges.map(([start, end]) => ({
                text: Buffer.from(hit.lineContent).subarray(start, end).toString("utf8"),
                start,
                end,
              })),
            })),
          )
        }
      }
    } finally {
      direct.value.destroy()
      await worker.destroy()
      await facade.destroy()
    }
    await expect(worker.fileSearch("search")).rejects.toMatchObject({ kind: "disposed" })
  }, 30000)

  test("32 admitted RPCs, interruptible backpressure, queued and active logical cancellation", async () => {
    await using tmp = await fixture()
    const worker = Fff.createWorker(options(tmp.path))
    expect(await worker.waitForScan(5000)).toBe(true)
    const controllers = Array.from({ length: 80 }, () => new AbortController())
    const results = controllers.map((controller) =>
      worker.grep("needle", { pageSize: 1000 }, controller.signal).then(
        () => "delivered",
        (error: unknown) => error,
      ),
    )
    expect(worker.state.active).toBe("grep")
    expect(worker.state.queued).toBe(31)
    expect(worker.state.waiting).toBe(48)
    const reason = new Error("explicit cancellation")
    controllers.forEach((controller) => controller.abort(reason))
    expect(worker.state.active).toBe("grep")
    expect(worker.state.queued).toBe(0)
    expect(worker.state.waiting).toBe(0)
    expect(await Promise.all(results)).toEqual(controllers.map(() => reason))
    // Slot release and later queries remain usable after the detached native call.
    expect((await worker.fileSearch("search")).totalMatched).toBeGreaterThan(0)
    await worker.destroy()
  })

  test("disposal settles callers, waits for active FFI and acknowledges native cleanup", async () => {
    await using tmp = await fixture()
    for (let i = 0; i < 8; i++) {
      const worker = Fff.createWorker(options(tmp.path))
      expect(await worker.waitForScan(5000)).toBe(true)
      const running = worker.grep("needle").catch((error: unknown) => error)
      const queued = worker.fileSearch("search").catch((error: unknown) => error)
      const closed = worker.destroy()
      expect(worker.destroy()).toBe(closed)
      expect(await running).toBeInstanceOf(FffError)
      expect(await queued).toBeInstanceOf(FffError)
      await closed
      expect(worker.state.active).toBeUndefined()
    }
    // Disposing during initialization must also destroy the eventual picker.
    const worker = Fff.createWorker(options(tmp.path))
    const pending = worker.fileSearch("search").catch((error: unknown) => error)
    await worker.destroy()
    expect(await pending).toMatchObject({ kind: "disposed" })
  }, 30000)

  for (const backend of ["worker", "direct"] as const) {
    test(`${backend} separate pickers and watcher freshness`, async () => {
      await using a = await fixture()
      await using b = await fixture()
      const create = backend === "worker" ? Fff.createWorker : Fff.createDirect
      const first = create(options(a.path))
      const second = create(options(b.path))
      try {
        expect(await Promise.all([first.waitForScan(5000), second.waitForScan(5000)])).toEqual([true, true])
        await Bun.write(`${a.path}/src/search.ts`, "unique_mutation\n")
        await Bun.write(`${a.path}/new-watch.ts`, "watch_content\n")
        const deadline = performance.now() + 5000
        while (!(await first.fileSearch("new-watch")).items.length && performance.now() < deadline) await Bun.sleep(25)
        expect((await first.fileSearch("new-watch")).items.map((x) => x.relativePath)).toContain("new-watch.ts")
        expect((await second.fileSearch("new-watch")).items).toHaveLength(0)
        expect((await first.grep("unique_mutation")).items[0]?.relativePath).toBe("src/search.ts")
        expect((await second.grep("unique_mutation")).items).toHaveLength(0)
      } finally {
        await Promise.all([first.destroy(), second.destroy()])
      }
    }, 15000)
  }

  test("real startup and native-init failure are classified; disposal remains safe", async () => {
    await using tmp = await fixture()
    const missing = new FffClient(options(tmp.path), () => new Worker(`${tmp.path}/missing-worker.ts`))
    await expect(missing.fileSearch("search")).rejects.toMatchObject({ kind: "transport" })
    await missing.destroy()
    const invalid = Fff.createWorker(options(`${tmp.path}/missing-directory`))
    await expect(invalid.fileSearch("search")).rejects.toMatchObject({ kind: "unavailable" })
    await invalid.destroy()
  })

  test("worker module evaluation failure is a transport failure", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/broken.ts`, 'throw new Error("failed worker startup")')
    const worker = new FffClient(options(tmp.path), () => new Worker(`${tmp.path}/broken.ts`))
    await expect(worker.fileSearch("search")).rejects.toMatchObject({ kind: "transport" })
    await worker.destroy()
  })

  test("bounded scheduling delivers every non-aborted request", async () => {
    await using tmp = await fixture()
    const worker = Fff.createWorker(options(tmp.path))
    try {
      expect(await worker.waitForScan(5000)).toBe(true)
      const all = await Promise.all(
        Array.from({ length: 70 }, (_, index) => worker.fileSearch(index % 2 ? "search" : "space")),
      )
      expect(all.every((value) => value.items.length > 0)).toBe(true)
      expect(worker.state.waiting).toBe(0)
      expect(worker.state.queued).toBe(0)
    } finally {
      await worker.destroy()
    }
  })

  test("large-page materialization preserves values and yields to cancellation", async () => {
    await using tmp = await fixture()
    const worker = Fff.createWorker(options(tmp.path))
    try {
      expect(await worker.waitForScan(5000)).toBe(true)
      const raw = await worker.grepMatches("needle", { pageSize: 1000, mode: "regex" })
      expect(raw.length).toBeGreaterThan(256)
      expect(JSON.stringify(await FileSystemSearch.materializeMatches(raw))).toBe(JSON.stringify(raw))
      const abort = new AbortController()
      const reason = new Error("cancel formatting")
      const pending = FileSystemSearch.materializeMatches(raw, abort.signal)
      abort.abort(reason)
      await expect(pending).rejects.toBe(reason)
    } finally {
      await worker.destroy()
    }
  })

  scoped.live("shared initialization survives an interrupted Effect caller", () =>
    withHarness(true, (gate) =>
      Effect.gen(function* () {
        const service = yield* FileSystemSearch.makeFff(() => gate.client)
        const first = yield* service.find({ query: "search" }).pipe(Effect.forkScoped)
        const second = yield* service.find({ query: "space" }).pipe(Effect.forkScoped)
        yield* Effect.promise(() => gate.wait("init-held"))
        expect(gate.client.state).toMatchObject({ active: "init", queued: 2, closing: false })
        yield* Fiber.interrupt(first)
        expect(Exit.hasInterrupts(yield* Fiber.await(first))).toBe(true)
        expect(gate.client.state).toMatchObject({ active: "init", queued: 1, closing: false })
        gate.command("release-init")
        expect(Exit.isSuccess(yield* Fiber.await(second))).toBe(true)
        expect(yield* Effect.promise(() => gate.client.waitForScan(5000))).toBe(true)
        expect(gate.client.state.backend).toBe("fff-worker")
        expect((yield* service.find({ query: "search" })).length).toBeGreaterThan(0)
        yield* Effect.promise(() => gate.client.destroy())
        const events = (yield* Effect.promise(() => Bun.file(gate.marker).text()))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        expect(events.map((event) => event.op)).toEqual(["init", "dispose"])
        expect(events[1].destroyed).toBe(true)
      }),
    ),
  )

  scoped.live("Effect interruption survives blocked admission, queued and active stages", () =>
    withHarness(false, (gate) =>
      Effect.gen(function* () {
        const service = yield* FileSystemSearch.makeFff(() => gate.client)
        expect(yield* Effect.promise(() => gate.client.waitForScan(5000))).toBe(true)
        const active = yield* service.grep({ pattern: "needle" }).pipe(Effect.forkScoped)
        yield* Effect.promise(() => gate.wait("grep-result-held"))
        // FFI really ran, but the result is held outside it. The caller's active
        // slot must remain occupied until delivery even after interruption.
        const fibers = yield* Effect.forEach(Array.from({ length: 40 }), () =>
          service.find({ query: "search" }).pipe(Effect.forkScoped),
        )
        yield* Effect.yieldNow
        expect(gate.client.state).toMatchObject({ active: "grep", queued: 31, waiting: 9 })
        yield* Fiber.interrupt(fibers[39])
        expect(Exit.hasInterrupts(yield* Fiber.await(fibers[39]))).toBe(true)
        expect(gate.client.state.waiting).toBe(8)
        yield* Fiber.interrupt(fibers[0])
        expect(Exit.hasInterrupts(yield* Fiber.await(fibers[0]))).toBe(true)
        expect(gate.client.state).toMatchObject({ active: "grep", queued: 31, waiting: 7 })
        yield* Fiber.interrupt(active)
        expect(Exit.hasInterrupts(yield* Fiber.await(active))).toBe(true)
        expect(gate.client.state).toMatchObject({ active: "grep", queued: 31, waiting: 7, closing: false })
        gate.command("release-grep")
        const remaining = fibers.filter((_, index) => index !== 0 && index !== 39)
        const exits = yield* Effect.forEach(remaining, (fiber) => Fiber.await(fiber))
        expect(exits.every(Exit.isSuccess)).toBe(true)
      }),
    ),
  )

  scoped.live("interrupting the owning scope destroys a late-created picker before completing", () =>
    withHarness(true, (gate) =>
      Effect.gen(function* () {
        const owner = yield* Effect.gen(function* () {
          const service = yield* FileSystemSearch.makeFff(() => gate.client)
          return yield* service.find({ query: "search" })
        }).pipe(Effect.scoped, Effect.forkScoped)
        yield* Effect.promise(() => gate.wait("init-held"))
        const interrupting = yield* Fiber.interrupt(owner).pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        expect(gate.client.state).toMatchObject({ active: "init", closing: true, queued: 0, waiting: 0 })
        gate.command("release-init")
        yield* Fiber.join(interrupting)
        expect(Exit.hasInterrupts(yield* Fiber.await(owner))).toBe(true)
        expect(gate.client.state).toMatchObject({ backend: "fff-worker", destroyed: true, started: false })
        const events = (yield* Effect.promise(() => Bun.file(gate.marker).text()))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        expect(events.map((event) => event.op)).toEqual(["init", "dispose"])
        expect(events[1].destroyed).toBe(true)
      }),
    ),
  )

  test("postMessage failure settles queued and admission callers, then destroys the live picker", async () => {
    await using tmp = await fixture()
    const gate = await harness(tmp.path)
    expect(await gate.client.waitForScan(5000)).toBe(true)
    const active = gate.client.grep("needle")
    await gate.wait("grep-result-held")
    const bad = {
      get currentFile(): string {
        throw new Error("structured clone getter failure")
      },
    }
    const pending = Array.from({ length: 80 }, (_, index) =>
      gate.client.fileSearch("search", index === 0 ? bad : undefined).catch((error: unknown) => error),
    )
    expect(gate.client.state).toMatchObject({ queued: 31, waiting: 49 })
    gate.command("release-grep")
    expect((await active).items.length).toBeGreaterThan(0)
    expect((await Promise.all(pending)).every((error) => error instanceof FffError && error.kind === "transport")).toBe(
      true,
    )
    await gate.client.destroy()
    expect(gate.client.state.destroyed).toBe(true)
  })

  test("postMessage failure while shutdown starts cannot strand disposal behind admission", async () => {
    await using tmp = await fixture()
    const gate = await harness(tmp.path)
    expect(await gate.client.waitForScan(5000)).toBe(true)
    const active = gate.client.grep("needle")
    await gate.wait("grep-result-held")
    const disposed = Promise.withResolvers<void>()
    const bad = {
      get currentFile(): string {
        disposed.resolve(gate.client.destroy())
        throw new Error("structured clone failure during shutdown")
      },
    }
    const pending = Array.from({ length: 80 }, (_, index) =>
      gate.client.fileSearch("search", index === 0 ? bad : undefined).catch((error: unknown) => error),
    )
    expect(gate.client.state).toMatchObject({ queued: 31, waiting: 49 })
    gate.command("release-grep")
    await active
    expect((await Promise.all(pending)).every((error) => error instanceof FffError)).toBe(true)
    await disposed.promise
    expect(gate.client.state).toMatchObject({ started: false, destroyed: true, queued: 0, waiting: 0 })
  })

  for (const failure of ["exit", "error"] as const) {
    for (const disposing of [false, true]) {
      test(`worker ${failure} settles a full starting queue and ${disposing ? "pending" : "later"} disposal`, async () => {
        await using tmp = await fixture()
        const gate = await harness(tmp.path, true)
        const pending = Array.from({ length: 80 }, () =>
          gate.client.fileSearch("search").catch((error: unknown) => error),
        )
        await gate.wait("init-held")
        expect(gate.client.state).toMatchObject({ active: "init", queued: 31, waiting: 49 })
        const disposal = disposing
          ? gate.client.destroy().then(
              () => undefined,
              (error: unknown) => error,
            )
          : undefined
        gate.command(failure)
        expect((await Promise.all(pending)).every((error) => error instanceof FffError)).toBe(true)
        if (disposing) expect(await disposal).toBeInstanceOf(FffError)
        if (!disposing) await gate.client.destroy()
        expect(gate.client.state).toMatchObject({ started: false, queued: 0, waiting: 0, destroyed: false })
        expect(await Bun.file(gate.marker).exists()).toBe(false)
      })
    }
  }

  for (const starting of [true, false]) {
    test(`watchdog proves exactly-once native cleanup with full ${starting ? "starting" : "active"} queue`, async () => {
      await using tmp = await fixture()
      const gate = await harness(tmp.path, starting)
      const child = Bun.spawn(
        [
          "timeout",
          "--signal=KILL",
          "15s",
          process.execPath,
          "-e",
          `
        import assert from "node:assert/strict"
        import { FffClient } from ${JSON.stringify(new URL("../../src/filesystem/fff-client.ts", import.meta.url).pathname)}
        const signals = new Map()
        const signal = name => {
          if (!signals.has(name)) signals.set(name, Promise.withResolvers())
          return signals.get(name)
        }
        let native
        const client = new FffClient(${JSON.stringify(options(tmp.path))}, () => {
          native = new Worker(${JSON.stringify(gate.entry)})
          native.addEventListener("message", event => { if (event.data.test) signal(event.data.test).resolve() })
          return native
        })
        if (!${starting}) assert.equal(await client.waitForScan(5000), true)
        const pending = Array.from({length: 80}, () => client.grep("needle").catch(error => error.kind))
        await signal(${JSON.stringify(starting ? "init-held" : "grep-result-held")}).promise
        assert.equal(client.state.queued, 31)
        assert.equal(client.state.waiting, ${starting ? 49 : 48})
        const disposed = client.destroy()
        assert.equal(client.destroy(), disposed)
        native.postMessage({test: ${JSON.stringify(starting ? "release-init" : "release-grep")}})
        assert.ok((await Promise.all(pending)).every(kind => kind === "disposed"))
        await disposed
        assert.equal(client.state.backend, "fff-worker")
        assert.equal(client.state.destroyed, true)
        assert.equal(client.state.started, false)
        const events = (await Bun.file(${JSON.stringify(gate.marker)}).text()).trim().split("\\n").map(JSON.parse)
        assert.deepEqual(events.map(event => event.op), ["init", "dispose"])
        assert.equal(events[1].destroyed, true)
        console.log("FFF_DESTROY_ACK_ONCE", JSON.stringify(client.state))
      `,
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      const output = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(output[2], output[1]).toBe(0)
      expect(output[0]).toContain("FFF_DESTROY_ACK_ONCE")
      const events = (await Bun.file(gate.marker).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(events.map((event) => event.op)).toEqual(["init", "dispose"])
      expect(events[1].destroyed).toBe(true)
    }, 20000)
  }
})

describe("fff parallel opt-in", () => {
  for (const setting of [undefined, "0", "false", "invalid", "1", "true"]) {
    test(`routing ${setting ?? "unset"} preserves the selected native backend`, async () => {
      await using tmp = await fixture()
      const env = { ...process.env }
      if (setting === undefined) delete env.OPENCODE_EXPERIMENTAL_FFF_WORKER
      if (setting !== undefined) env.OPENCODE_EXPERIMENTAL_FFF_WORKER = setting
      const expected = setting === "1" || setting === "true" ? "fff-worker" : "fff-direct"
      const child = Bun.spawn(
        [
          "timeout",
          "--signal=KILL",
          "15s",
          process.execPath,
          "-e",
          `
        import assert from "node:assert/strict"
        import { Fff } from ${JSON.stringify(new URL("../../src/filesystem/fff.bun.ts", import.meta.url).pathname)}
        const picker = Fff.create(${JSON.stringify(options(tmp.path))})
        assert.equal(picker.state.started, false)
        assert.equal(await picker.waitForScan(5000), true)
        assert.ok((await picker.fileSearch("search")).items.length > 0)
        assert.equal(picker.state.backend, ${JSON.stringify(expected)})
        await picker.destroy()
        assert.equal(picker.state.destroyed, true)
        assert.equal(picker.state.started, false)
        console.log("NATIVE_BACKEND", picker.state.backend)
      `,
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      )
      const result = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(result[2], result[1]).toBe(0)
      expect(result[0]).toContain(`NATIVE_BACKEND ${expected}`)
    }, 20000)
  }

  test("direct initialization cancellation and disposal are independent and idempotent", async () => {
    await using tmp = await fixture()
    const unused = Fff.createDirect(options(tmp.path))
    const preaborted = new AbortController()
    preaborted.abort(new Error("not admitted"))
    await expect(unused.fileSearch("search", undefined, preaborted.signal)).rejects.toBe(preaborted.signal.reason)
    expect(unused.state.started).toBe(false)
    await unused.destroy()
    expect(unused.state.destroyed).toBe(false)

    const picker = Fff.createDirect(options(tmp.path))
    const abort = new AbortController()
    const first = picker.waitForScan(5000, abort.signal).catch((error: unknown) => error)
    const other = picker.waitForScan(5000)
    abort.abort(new Error("one caller only"))
    expect(await first).toBe(abort.signal.reason)
    expect(await other).toBe(true)
    expect((await picker.fileSearch("search")).items.length).toBeGreaterThan(0)
    const closed = picker.destroy()
    expect(picker.destroy()).toBe(closed)
    await closed
    expect(picker.state).toMatchObject({ backend: "fff-direct", destroyed: true, started: false })
    await expect(picker.grep("needle")).rejects.toMatchObject({ kind: "disposed" })

    const late = Fff.createDirect(options(tmp.path))
    const pending = late.fileSearch("search").catch((error: unknown) => error)
    await late.destroy()
    expect(await pending).toMatchObject({ kind: "disposed" })
    expect(late.state).toMatchObject({ backend: "fff-direct", destroyed: true, started: false })
    const invalid = Fff.createDirect(options(`${tmp.path}/missing`))
    await expect(invalid.fileSearch("search")).rejects.toMatchObject({ kind: "unavailable" })
    const failed = invalid.destroy()
    expect(invalid.destroy()).toBe(failed)
    await failed
    expect(invalid.state.destroyed).toBe(false)
  })

  test("direct disposal cannot free a handle borrowed by an executing native operation", async () => {
    await using tmp = await fixture()
    const picker = Fff.createDirect(options(tmp.path))
    expect(await picker.waitForScan(5000)).toBe(true)
    const closed = Promise.withResolvers<void>()
    const result = picker.fileSearch("search", {
      get currentFile() {
        // The SDK has already captured its native handle before reading this
        // option. Shutdown must wait for the operation, not free that handle.
        closed.resolve(picker.destroy())
        return ""
      },
    })
    await expect(result).rejects.toMatchObject({ kind: "disposed" })
    await closed.promise
    expect(picker.state).toMatchObject({ started: false, destroyed: true })
  })

  scoped.live("direct shared initialization preserves an actual interrupted Effect Exit", () =>
    withDirect((picker) =>
      Effect.gen(function* () {
        const service = yield* FileSystemSearch.makeFff(() => picker)
        const first = yield* service.find({ query: "search" }).pipe(Effect.forkScoped({ startImmediately: true }))
        const other = yield* service.find({ query: "space" }).pipe(Effect.forkScoped({ startImmediately: true }))
        expect(picker.state.active).toBe("init")
        yield* Fiber.interrupt(first)
        expect(Exit.hasInterrupts(yield* Fiber.await(first))).toBe(true)
        expect(Exit.isSuccess(yield* Fiber.await(other))).toBe(true)
        expect(yield* Effect.promise(() => picker.waitForScan(5000))).toBe(true)
        expect(picker.state.backend).toBe("fff-direct")
        expect((yield* service.find({ query: "search" })).length).toBeGreaterThan(0)
      }),
    ),
  )

  scoped.live("direct scope interruption destroys a late-created picker", () =>
    withDirect((picker) =>
      Effect.gen(function* () {
        const owner = yield* Effect.gen(function* () {
          const service = yield* FileSystemSearch.makeFff(() => picker)
          return yield* service.find({ query: "search" })
        }).pipe(Effect.scoped, Effect.forkScoped({ startImmediately: true }))
        expect(picker.state.active).toBe("init")
        yield* Fiber.interrupt(owner)
        expect(Exit.hasInterrupts(yield* Fiber.await(owner))).toBe(true)
        expect(picker.state).toMatchObject({ backend: "fff-direct", destroyed: true, started: false })
      }),
    ),
  )
})

describe("shared fff executor", () => {
  test("actual Node runtime keeps the unavailable-native contract with the opt-in set", async () => {
    await using tmp = await fixture()
    const build = await Bun.build({
      entrypoints: [new URL("../../src/filesystem/fff.node.ts", import.meta.url).pathname],
      target: "node",
    })
    expect(build.success).toBe(true)
    await Bun.write(`${tmp.path}/fff.mjs`, build.outputs[0]!)
    const child = Bun.spawn(
      [
        "node",
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict"
      import { Fff } from ${JSON.stringify(`${tmp.path}/fff.mjs`)}
      assert.equal(Fff.available(), false)
      for (const create of [Fff.create, Fff.createDirect, Fff.createWorker]) {
        assert.throws(() => create(${JSON.stringify(options(tmp.path))}), error => error.kind === "unavailable")
      }
    `,
      ],
      { env: { ...process.env, OPENCODE_EXPERIMENTAL_FFF_WORKER: "1" }, stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stdout + stderr).toBe(0)
  })

  for (const setting of ["1", "2", "8", "invalid", "0", "9"]) {
    test(`actual worker budget ${setting} is bounded and all owners clean up`, async () => {
      await using tmp = await fixture()
      const expected = ["1", "2", "8"].includes(setting) ? Number(setting) : 2
      const child = Bun.spawn(
        [
          "timeout",
          "--signal=KILL",
          "15s",
          process.execPath,
          "-e",
          `
        import assert from "node:assert/strict"
        import { Fff } from ${JSON.stringify(new URL("../../src/filesystem/fff.bun.ts", import.meta.url).pathname)}
        const clients = Array.from({length: 9}, () => Fff.createWorker(${JSON.stringify(options(tmp.path))}))
        assert.equal(Fff.executorState().workers, 0)
        assert.ok((await Promise.all(clients.map(client => client.waitForScan(5000)))).every(Boolean))
        assert.equal(Fff.executorState().workers, ${expected})
        assert.equal(Fff.executorState().pickers, 9)
        await Promise.all(clients.map(client => client.destroy()))
        assert.ok(clients.every(client => client.state.destroyed && !client.state.started))
        assert.deepEqual(Fff.executorState(), {workers:0, pickers:0, queued:0})
      `,
        ],
        { env: { ...process.env, OPENCODE_FFF_WORKERS: setting }, stdout: "pipe", stderr: "pipe" },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, stdout + stderr).toBe(0)
    }, 20000)
  }

  test("without Worker the opt-in uses real direct native search", async () => {
    await using tmp = await fixture()
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      import assert from "node:assert/strict"
      // Only a subprocess capability removal can exercise the no-Worker host.
      Object.defineProperty(globalThis, "Worker", {value: undefined})
      const { Fff } = await import(${JSON.stringify(new URL("../../src/filesystem/fff.bun.ts", import.meta.url).pathname)})
      const picker = Fff.create(${JSON.stringify(options(tmp.path))})
      assert.equal(await picker.waitForScan(5000), true)
      assert.ok((await picker.fileSearch("search")).items.length)
      assert.equal(picker.state.backend, "fff-direct")
      await picker.destroy()
      assert.equal(picker.state.destroyed, true)
      assert.equal(Fff.executorState().workers, 0)
    `,
      ],
      { env: { ...process.env, OPENCODE_EXPERIMENTAL_FFF_WORKER: "1" }, stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stdout + stderr).toBe(0)
  })

  test("bounds worker lanes across Locations and disposes each native handle independently", async () => {
    await using a = await fixture()
    await using b = await fixture()
    const clients = Array.from({ length: 6 }, (_, index) => Fff.createWorker(options(index % 2 ? a.path : b.path)))
    try {
      expect((await Promise.all(clients.map((client) => client.waitForScan(5000)))).every(Boolean)).toBe(true)
      expect(Fff.executorState()).toMatchObject({ workers: 2, pickers: 6 })
      await clients[0]?.destroy()
      expect(Fff.executorState()).toMatchObject({ workers: 2, pickers: 5 })
      expect((await clients[2]?.fileSearch("search"))?.items.length).toBeGreaterThan(0)
      await Bun.write(`${a.path}/shared-fresh.ts`, "new content\n")
      const deadline = performance.now() + 5000
      while (!(await clients[1]?.fileSearch("shared-fresh"))?.items.length && performance.now() < deadline)
        await Bun.sleep(25)
      expect((await clients[1]?.fileSearch("shared-fresh"))?.items.length).toBe(1)
      expect((await clients[2]?.fileSearch("shared-fresh"))?.items.length).toBe(0)
    } finally {
      await Promise.all(clients.map((client) => client.destroy()))
    }
    expect(Fff.executorState()).toEqual({ workers: 0, pickers: 0, queued: 0 })
  })

  test("bounds admission closures and removes cancelled/overflow work", async () => {
    await using tmp = await fixture()
    const gate = await harness(tmp.path, true)
    const abort = new AbortController()
    const pending = Array.from({ length: 400 }, () =>
      gate.client.fileSearch("search", undefined, abort.signal).catch((error: unknown) => error),
    )
    await gate.wait("init-held")
    expect(gate.client.state).toMatchObject({ active: "init", queued: 31, waiting: 128 })
    abort.abort(new Error("obsolete"))
    const errors = await Promise.all(pending)
    expect(errors.filter((error) => error instanceof FffError && error.kind === "busy")).toHaveLength(241)
    expect(gate.client.state).toMatchObject({ queued: 0, waiting: 0 })
    const disposed = gate.client.destroy()
    gate.command("release-init")
    await disposed
    expect(gate.client.state.destroyed).toBe(true)
  })

  test("a full waiting cohort drains normally instead of rejecting its admitted waiters", async () => {
    await using tmp = await fixture()
    const gate = await harness(tmp.path, true)
    const pending = Array.from({ length: 159 }, () => gate.client.waitForScan(5000))
    await gate.wait("init-held")
    expect(gate.client.state.waiting).toBe(128)
    gate.command("release-init")
    expect((await Promise.all(pending)).every(Boolean)).toBe(true)
    await gate.client.destroy()
    expect(gate.client.state).toMatchObject({ waiting: 0, queued: 0, destroyed: true })
  })

  test("a failed shared worker settles all logical owners and can be replaced", async () => {
    await using tmp = await fixture()
    await Bun.write(`${tmp.path}/failed-pool.ts`, 'throw new Error("executor failed")')
    const pool = new FffPool(() => new Worker(`${tmp.path}/failed-pool.ts`), 1)
    const clients = Array.from({ length: 3 }, () => new FffClient(options(tmp.path), () => pool.acquire()))
    expect(
      (await Promise.all(clients.map((client) => client.fileSearch("search").catch((error: unknown) => error)))).every(
        (error) => error instanceof FffError && error.kind === "transport",
      ),
    ).toBe(true)
    await Promise.all(clients.map((client) => client.destroy()))
    expect(pool.state).toEqual({ workers: 0, pickers: 0, queued: 0 })
    await Bun.write(
      `${tmp.path}/failed-pool.ts`,
      `import ${JSON.stringify(new URL("../../src/filesystem/fff.worker.ts", import.meta.url).href)}`,
    )
    const recovered = new FffClient(options(tmp.path), () => pool.acquire())
    expect(await recovered.waitForScan(5000)).toBe(true)
    await recovered.destroy()
    expect(recovered.state.destroyed).toBe(true)
    expect(pool.state.workers).toBe(0)
  })

  test("shared transport clone failure preserves native disposal acknowledgement", async () => {
    await using tmp = await fixture()
    const pool = new FffPool(() => new Worker(new URL("../../src/filesystem/fff.worker.ts", import.meta.url)), 1)
    const client = new FffClient(options(tmp.path), () => pool.acquire())
    const survivor = new FffClient(options(tmp.path), () => pool.acquire())
    expect(await client.waitForScan(5000)).toBe(true)
    expect(await survivor.waitForScan(5000)).toBe(true)
    await expect(
      client.fileSearch("search", {
        get currentFile(): string {
          throw new Error("clone")
        },
      }),
    ).rejects.toMatchObject({ kind: "transport" })
    await client.destroy()
    expect(client.state.destroyed).toBe(true)
    expect((await survivor.fileSearch("search")).items.length).toBeGreaterThan(0)
    await survivor.destroy()
    expect(Fff.executorState().workers).toBe(0)
  })

  test("queued shared RPC cancellation skips native work and a hot owner cannot starve its peer", async () => {
    await using tmp = await fixture()
    const gate = await harness(tmp.path)
    let native: Worker | undefined
    const held = Promise.withResolvers<void>()
    const pool = new FffPool(() => {
      const worker = new Worker(gate.entry)
      native = worker
      worker.addEventListener("message", (event: MessageEvent<{ test?: string }>) => {
        if (event.data.test === "grep-result-held") held.resolve()
      })
      return worker
    }, 1)
    const hot = new FffClient(options(tmp.path), () => pool.acquire())
    const peer = new FffClient(options(tmp.path), () => pool.acquire())
    expect(await hot.waitForScan(5000)).toBe(true)
    expect(await peer.waitForScan(5000)).toBe(true)
    const active = hot.grep("needle")
    await held.promise
    const abort = new AbortController()
    const obsolete = peer.fileSearch("search", undefined, abort.signal).catch((error: unknown) => error)
    expect(pool.state.queued).toBe(1)
    abort.abort(new Error("obsolete native RPC"))
    expect(await obsolete).toBe(abort.signal.reason)
    expect(pool.state.queued).toBe(0)
    expect(peer.state).toMatchObject({ active: undefined, queued: 0, waiting: 0 })
    let delivered = 0
    const traffic = Array.from({ length: 80 }, () =>
      hot.fileSearch("search").then(() => {
        delivered++
      }),
    )
    const fresh = peer.fileSearch("space")
    native?.postMessage({ test: "release-grep" })
    await active
    expect((await fresh).items.length).toBeGreaterThan(0)
    expect(delivered).toBeLessThan(80)
    await Promise.all(traffic)
    await Promise.all([hot.destroy(), peer.destroy()])
    expect(pool.state).toEqual({ workers: 0, pickers: 0, queued: 0 })
  })
})

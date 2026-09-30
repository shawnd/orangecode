import { FffClient } from "./fff-client"
import { FffError, formatGrep } from "./fff-types"
import type { GrepOptions, Init, Picker, SearchOptions } from "./fff-types"
import type { FileFinder, Result } from "@ff-labs/fff-bun"

export type * from "./fff-types"
export { FffError } from "./fff-types"

declare const OPENCODE_FFF_WORKER_PATH: string

// Capability only: neither backend loads native code when a Location is created.
export function available() {
  return true
}

export function create(opts: Init) {
  // The worker improves responsiveness, but large distinct-line pages still
  // miss the latency gate. Preserve direct native FFF unless explicitly opted in.
  const worker = process.env.OPENCODE_EXPERIMENTAL_FFF_WORKER
  return worker === "1" || worker === "true" ? createWorker(opts) : createDirect(opts)
}

export function createWorker(opts: Init) {
  return new FffClient(
    opts,
    () =>
      new Worker(
        typeof OPENCODE_FFF_WORKER_PATH !== "undefined"
          ? OPENCODE_FFF_WORKER_PATH
          : new URL("./fff.worker.ts", import.meta.url),
        { name: "fff" },
      ),
  )
}

export function createDirect(opts: Init) {
  return new Direct(opts)
}

class Direct implements Picker {
  private initialization?: Promise<FileFinder>
  private picker?: FileFinder
  private loaded = false
  private destroyed = false
  private closing?: Promise<void>
  private failure?: { cause: unknown }
  private pending = new Set<(error: unknown) => void>()
  private running = new Set<Promise<void>>()

  constructor(private readonly options: Init) {}

  get state() {
    return {
      started: !!this.picker,
      active: !this.loaded && this.pending.size ? ("init" as const) : undefined,
      queued: 0,
      waiting: this.pending.size,
      closing: !!this.closing,
      backend: this.loaded ? ("fff-direct" as const) : undefined,
      workerPath: undefined,
      destroyed: this.destroyed,
    }
  }

  private initialize() {
    if (this.initialization) return this.initialization
    this.initialization = (async () => {
      const { FileFinder } = await import("@ff-labs/fff-bun").catch(() => {
        throw new FffError("unavailable", "fff library could not load")
      })
      if (!FileFinder.isAvailable()) throw new FffError("unavailable", "fff library unavailable")
      const result = FileFinder.create(this.options)
      if (!result.ok) throw new FffError("unavailable", "fff picker could not initialize")
      this.picker = result.value
      this.loaded = true
      return result.value
    })().catch((cause: unknown) => {
      this.failure = { cause }
      // Settle the entire init cohort before service-level fallback disposes
      // this client; peers must see availability failure, not a disposal race.
      Array.from(this.pending).forEach((fail) => fail(cause))
      throw cause
    })
    return this.initialization
  }

  private run<A>(call: (picker: FileFinder) => Result<A> | Promise<Result<A>>, signal?: AbortSignal): Promise<A> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.closing) return Promise.reject(new FffError("disposed", "fff disposed"))
    if (this.failure) return Promise.reject(this.failure.cause)
    // Initialization belongs to the Location, not any one interruptible caller.
    const task = this.initialize()
      .then((picker) => {
        signal?.throwIfAborted()
        if (this.closing) throw new FffError("disposed", "fff disposed")
        return call(picker)
      })
      .then((result) => {
        if (!result.ok) throw new FffError("query", result.error)
        return result.value
      })
    // Direct synchronous FFI cannot be preempted. Async scan polling must also
    // finish before destroying its native handle, even if its caller detached.
    const running = task.then(
      () => {},
      () => {},
    )
    this.running.add(running)
    void running.then(() => this.running.delete(running))
    return new Promise<A>((resolve, reject) => {
      const detach = () => {
        this.pending.delete(fail)
        signal?.removeEventListener("abort", abort)
      }
      const fail = (error: unknown) => {
        detach()
        reject(error)
      }
      const abort = () => fail(signal?.reason)
      this.pending.add(fail)
      signal?.addEventListener("abort", abort, { once: true })
      task.then((value) => {
        detach()
        resolve(value)
      }, fail)
    })
  }

  destroy() {
    if (this.closing) return this.closing
    const done = Promise.withResolvers<void>()
    this.closing = done.promise
    const error = new FffError("disposed", "fff disposed")
    Array.from(this.pending).forEach((fail) => fail(error))
    // All admitted operations include shared initialization. A late-created
    // picker is therefore destroyed here rather than leaked after interruption.
    Promise.all(Array.from(this.running))
      .then(() => {
        this.picker?.destroy()
        this.destroyed = this.picker?.isDestroyed ?? false
        this.picker = undefined
      })
      .then(done.resolve, done.reject)
    return this.closing
  }

  waitForScan(timeoutMs?: number, signal?: AbortSignal) {
    return this.run((picker) => picker.waitForScan(timeoutMs), signal)
  }
  fileSearch(query: string, opts?: SearchOptions, signal?: AbortSignal) {
    return this.run((picker) => picker.fileSearch(query, opts), signal)
  }
  glob(query: string, opts?: SearchOptions, signal?: AbortSignal) {
    return this.run((picker) => picker.glob(query, opts), signal)
  }
  directorySearch(query: string, opts?: SearchOptions, signal?: AbortSignal) {
    return this.run((picker) => picker.directorySearch(query, opts), signal)
  }
  mixedSearch(query: string, opts?: SearchOptions, signal?: AbortSignal) {
    return this.run((picker) => picker.mixedSearch(query, opts), signal)
  }
  grep(query: string, opts?: GrepOptions, signal?: AbortSignal) {
    return this.run((picker) => picker.grep(query, opts), signal)
  }
  grepMatches(query: string, opts?: GrepOptions, signal?: AbortSignal) {
    return this.run((picker) => {
      const result = picker.grep(query, opts)
      if (!result.ok) return result
      return { ok: true, value: formatGrep(result.value) }
    }, signal)
  }
}

export * as Fff from "./fff.bun"

import { FffError } from "./fff-types"
import type { GrepOptions, Init, Operations, Picker, Request, Response, SearchOptions } from "./fff-types"

type Pending = {
  request: Request
  resolve: (value: Operations[keyof Operations]["value"]) => void
  reject: (error: unknown) => void
  detach: () => void
}

export class FffClient implements Picker {
  private worker?: Worker
  private active?: Pending
  private queue: Pending[] = []
  private waiting = new Set<() => void>()
  private sequence = 0
  private failure?: FffError
  private closing?: Promise<void>
  private closed?: () => void
  private disposalError?: unknown
  private finished = false
  private initialization?: Operations["init"]["value"]
  private destroyed = false

  constructor(
    private readonly init: Init,
    private readonly spawn: () => Worker,
  ) {}

  // Diagnostics expose scheduling state, never queries or native handles.
  get state() {
    return {
      started: !!this.worker,
      active: this.active?.request.op,
      queued: this.queue.length,
      waiting: this.waiting.size,
      closing: !!this.closing,
      backend: this.initialization?.backend,
      workerPath: this.initialization?.workerPath,
      destroyed: this.destroyed,
    }
  }

  private nextID() {
    if (this.sequence === Number.MAX_SAFE_INTEGER) throw new FffError("defect", "fff request IDs exhausted")
    return ++this.sequence
  }

  private start() {
    if (this.worker || this.failure) return
    try {
      const worker = this.spawn()
      this.worker = worker
      worker.onmessage = (event: MessageEvent<Response>) => {
        const pending = this.active
        if (!pending || event.data.id !== pending.request.id) return
        this.active = undefined
        pending.detach()
        if (event.data.ok) pending.resolve(event.data.value)
        else pending.reject(new FffError(event.data.error.kind, event.data.error.message))
        this.pump()
      }
      worker.onerror = (event) => {
        event.preventDefault()
        if (this.closing && !this.finished) {
          this.disposalError = new FffError("transport", "fff failed before disposal acknowledgement")
        }
        this.fail(new FffError("transport", "fff worker failed"))
        // Operation exceptions are returned as DTOs. An uncaught worker error
        // means the transport is gone, not a cancellable native operation.
        this.active = undefined
        worker.terminate()
        this.worker = undefined
        this.closed?.()
      }
      worker.addEventListener("close", () => {
        if (!this.closing) this.fail(new FffError("transport", "fff worker closed"))
        if (this.closing && !this.finished) {
          this.disposalError = new FffError("transport", "fff closed before disposal acknowledgement")
        }
        this.active = undefined
        this.worker = undefined
        this.closed?.()
      })
      this.send({
        request: { id: this.nextID(), op: "init", args: [this.init] },
        resolve: (value) => {
          if (!value || typeof value !== "object" || !("backend" in value)) {
            this.fail(new FffError("defect", "invalid fff initialization acknowledgement"))
            return
          }
          this.initialization = value
        },
        reject: (error) => {
          this.fail(error instanceof FffError ? error : new FffError("defect", "fff init failed"))
        },
        detach: () => {},
      })
    } catch {
      this.fail(new FffError("transport", "fff worker could not start"))
    }
  }

  private fail(error: FffError) {
    if (this.failure) return
    this.failure = error
    const reject = this.active?.reject
    if (this.active) this.active.reject = () => {}
    reject?.(error)
    this.active?.detach()
    this.queue.splice(0).forEach((pending) => {
      pending.detach()
      pending.reject(error)
    })
    Array.from(this.waiting).forEach((resume) => resume())
  }

  private send(pending: Pending) {
    this.active = pending
    try {
      // Keep pending work/destruction acknowledgement alive regardless of the
      // worker's default ref mode. Some consumers use DOM-only Worker typings.
      if (this.worker && "ref" in this.worker && typeof this.worker.ref === "function") this.worker.ref()
      this.worker?.postMessage(pending.request)
    } catch {
      this.active = undefined
      pending.detach()
      const error = new FffError("transport", "fff worker send failed")
      pending.reject(error)
      this.fail(error)
      this.pump()
    }
  }

  private pump() {
    if (this.finished) return
    if (this.active) return
    if (this.closing) {
      if (!this.worker) return this.closed?.()
      this.send({
        request: { id: this.nextID(), op: "dispose", args: [] },
        resolve: (value) => {
          const ack = value && typeof value === "object" && "destroyed" in value ? value : undefined
          this.disposalError = ack ? undefined : new FffError("defect", "invalid fff disposal acknowledgement")
          this.destroyed = ack?.destroyed ?? false
          this.finished = true
          this.worker?.terminate()
        },
        reject: (error) => {
          this.disposalError = error
          this.finished = true
          this.worker?.terminate()
        },
        detach: () => {},
      })
      return
    }
    if (this.failure) return
    const next = this.queue.shift()
    if (next) this.send(next)
    Array.from(this.waiting).forEach((resume) => resume())
    if (!this.active && this.worker && "unref" in this.worker && typeof this.worker.unref === "function") {
      this.worker.unref()
    }
  }

  private request<K extends keyof Operations>(
    op: K,
    args: Operations[K]["args"],
    signal?: AbortSignal,
  ): Promise<Operations[K]["value"]> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.closing) return Promise.reject(new FffError("disposed", "fff disposed"))
    this.start()
    return new Promise<Operations[keyof Operations]["value"]>((resolve, reject) => {
      const abort = () => {
        this.waiting.delete(admit)
        const index = pending ? this.queue.indexOf(pending) : -1
        if (index !== -1) this.queue.splice(index, 1)
        signal?.removeEventListener("abort", abort)
        reject(signal?.reason)
        // An active caller detaches immediately, but its slot remains occupied
        // until the response arrives and fff has freed the result normally.
        if (pending && pending === this.active) {
          pending.resolve = () => {}
          pending.reject = () => {}
        }
        Array.from(this.waiting).forEach((resume) => resume())
      }
      let pending: Pending | undefined
      const admit = () => {
        if (this.failure || this.closing) {
          this.waiting.delete(admit)
          signal?.removeEventListener("abort", abort)
          reject(this.failure ?? new FffError("disposed", "fff disposed"))
          return
        }
        if (this.queue.length + Number(!!this.active) >= 32) {
          this.waiting.add(admit)
          return
        }
        this.waiting.delete(admit)
        pending = {
          // op and args are correlated at this single typed RPC boundary.
          request: { id: this.nextID(), op, args } as Request,
          resolve,
          reject,
          detach: () => signal?.removeEventListener("abort", abort),
        }
        this.queue.push(pending)
        this.pump()
      }
      signal?.addEventListener("abort", abort, { once: true })
      admit()
    }).then((value) => value as Operations[K]["value"])
  }

  destroy() {
    if (this.closing) return this.closing
    this.closing = new Promise<void>((resolve, reject) => {
      this.closed = () => (this.disposalError === undefined ? resolve() : reject(this.disposalError))
    })
    const error = new FffError("disposed", "fff disposed")
    this.queue.splice(0).forEach((pending) => {
      pending.detach()
      pending.reject(error)
    })
    Array.from(this.waiting).forEach((resume) => resume())
    // Initialization is control-plane ownership, not one caller's request.
    // Preserve its completion bookkeeping when a picker is created late.
    if (this.active && this.active.request.op !== "init") {
      this.active.detach()
      this.active.reject(error)
      this.active.resolve = () => {}
      this.active.reject = () => {}
    }
    this.pump()
    return this.closing
  }

  waitForScan(timeoutMs?: number, signal?: AbortSignal) {
    return this.request("waitForScan", [timeoutMs], signal)
  }
  fileSearch(query: string, opts?: SearchOptions, signal?: AbortSignal) {
    return this.request("fileSearch", [query, opts], signal)
  }
  glob(query: string, opts?: SearchOptions, signal?: AbortSignal) {
    return this.request("glob", [query, opts], signal)
  }
  directorySearch(query: string, opts?: SearchOptions, signal?: AbortSignal) {
    return this.request("directorySearch", [query, opts], signal)
  }
  mixedSearch(query: string, opts?: SearchOptions, signal?: AbortSignal) {
    return this.request("mixedSearch", [query, opts], signal)
  }
  async grep(query: string, opts?: GrepOptions, signal?: AbortSignal) {
    const result = await this.request("grep", [query, opts], signal)
    if (Array.isArray(result)) throw new FffError("defect", "invalid grep response")
    return result
  }
  async grepMatches(query: string, opts?: GrepOptions, signal?: AbortSignal) {
    const result = await this.request("grep", [query, opts, true], signal)
    if (!Array.isArray(result)) throw new FffError("defect", "invalid grep response")
    return result
  }
}

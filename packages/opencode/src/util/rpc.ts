type Definition = {
  [method: string]: (input: never) => unknown
}

export function listen(rpc: Definition) {
  onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.request") {
      try {
        const result = await rpc[parsed.method](parsed.input as never)
        postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))
      } catch (error) {
        postMessage(JSON.stringify({ type: "rpc.error", error: serializeError(error), id: parsed.id }))
      }
    }
  }
}

type SerializedError = {
  name: string
  message: string
  stack?: string
  code?: string | number
  cause?: SerializedError
}

function serializeError(error: unknown, depth = 0): SerializedError {
  if (!(error instanceof Error)) {
    try {
      return { name: "Error", message: String(error) }
    } catch {
      return { name: "Error", message: "Unknown RPC error" }
    }
  }
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code:
      "code" in error && (typeof error.code === "string" || typeof error.code === "number") ? error.code : undefined,
    // Bound cyclic/deep causes while retaining the actual listener failure inside Effect's ServeError.
    cause: depth < 8 && error.cause !== undefined ? serializeError(error.cause, depth + 1) : undefined,
  }
}

function deserializeError(input: SerializedError): Error {
  const error = new Error(input.message, input.cause ? { cause: deserializeError(input.cause) } : undefined)
  error.name = input.name
  if (input.stack) error.stack = input.stack
  if (input.code !== undefined) Object.assign(error, { code: input.code })
  return error
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(
  target: Pick<Worker, "postMessage" | "addEventListener" | "removeEventListener">,
) {
  const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>()
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  let closed: Error | undefined
  let id = 0
  const message = (evt: MessageEvent) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.result" || parsed.type === "rpc.error") {
      const call = pending.get(parsed.id)
      if (call) {
        pending.delete(parsed.id)
        if (parsed.type === "rpc.result") call.resolve(parsed.result)
        if (parsed.type === "rpc.error") {
          call.reject(deserializeError(parsed.error))
        }
      }
    }
    if (parsed.type === "rpc.event") {
      const handlers = listeners.get(parsed.event)
      if (handlers) {
        for (const handler of handlers) {
          handler(parsed.data)
        }
      }
    }
  }
  const dispose = (error = new Error("RPC client closed")) => {
    if (closed) return
    closed = error
    target.removeEventListener("message", message)
    target.removeEventListener("error", failed)
    target.removeEventListener("close", close)
    pending.forEach((call) => call.reject(error))
    pending.clear()
    listeners.clear()
  }
  const failed = (evt: ErrorEvent) =>
    dispose(evt.error instanceof Error ? evt.error : new Error(evt.message || "Worker error"))
  const close = () => dispose(new Error("Worker closed"))
  target.addEventListener("message", message)
  target.addEventListener("error", failed)
  target.addEventListener("close", close)
  return {
    dispose,
    call<Method extends keyof T>(
      method: Method,
      input: Parameters<T[Method]>[0],
    ): Promise<Awaited<ReturnType<T[Method]>>> {
      if (closed) return Promise.reject(closed)
      const requestId = id++
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve: (result) => resolve(result as Awaited<ReturnType<T[Method]>>), reject })
        try {
          target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
        } catch (error) {
          pending.delete(requestId)
          reject(error)
        }
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      if (closed) return () => {}
      const handlers = listeners.get(event) ?? new Set<(data: unknown) => void>()
      listeners.set(event, handlers)
      const listener = handler as (data: unknown) => void
      handlers.add(listener)
      return () => {
        handlers.delete(listener)
        if (handlers.size === 0 && listeners.get(event) === handlers) listeners.delete(event)
      }
    },
  }
}

export * as Rpc from "./rpc"

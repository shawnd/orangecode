import { FffError } from "./fff-types"
import type { Request, Response, Transport } from "./fff-types"

// A process-wide native executor, not a backend per terminal client. Logical
// pickers remain Location-owned; disposing one never destroys another's handle.
export class FffPool {
  private lanes: Lane[] = []
  private sequence = 0

  constructor(
    private readonly spawn: () => Worker,
    private readonly limit = 2,
  ) {}

  get state() {
    return {
      workers: this.lanes.length,
      pickers: this.lanes.reduce((sum, lane) => sum + lane.ports.size, 0),
      queued: this.lanes.reduce((sum, lane) => sum + lane.queue.length, 0),
    }
  }

  acquire(): Transport {
    const lane =
      this.lanes.length < this.limit ? this.start() : this.lanes.toSorted((a, b) => a.ports.size - b.ports.size)[0]
    if (!lane) throw new FffError("transport", "fff executor unavailable")
    const id = ++this.sequence
    const close = new Set<() => void>()
    const port: Transport = {
      onmessage: null,
      onerror: null,
      addEventListener: (_, listener) => {
        close.add(listener)
      },
      postMessage: (request) => {
        if (!lane.ports.has(id)) throw new FffError("transport", "fff executor closed")
        // FffClient sends at most one RPC per logical picker. FIFO lanes are
        // therefore round-robin among ready pickers even under a hot Location.
        lane.queue.push(structuredClone({ ...request, pickerID: id }))
        this.pump(lane)
      },
      cancel: (requestID) => {
        const index = lane.queue.findIndex((request) => request.pickerID === id && request.id === requestID)
        if (index === -1) return false
        lane.queue.splice(index, 1)
        return true
      },
      ref: () => lane.worker.ref?.(),
      unref: () => {
        if (!lane.active && !lane.queue.length) lane.worker.unref?.()
      },
      terminate: () => {
        if (!lane.ports.delete(id)) return
        lane.queue = lane.queue.filter((request) => request.pickerID !== id)
        // Native disposal acknowledgement precedes logical termination. Never
        // terminate a worker executing another Location's synchronous FFI.
        if (!lane.ports.size) {
          lane.worker.terminate()
          this.lanes = this.lanes.filter((value) => value !== lane)
        }
        queueMicrotask(() => close.forEach((listener) => listener()))
      },
    }
    lane.ports.set(id, port)
    return port
  }

  private start() {
    const worker = this.spawn()
    const lane: Lane = { worker, ports: new Map(), queue: [] }
    worker.onmessage = (event: MessageEvent<Response>) => {
      const active = lane.active
      if (!active || event.data.pickerID !== active.pickerID || event.data.id !== active.id) return
      lane.active = undefined
      lane.ports.get(active.pickerID ?? 0)?.onmessage?.(event)
      this.pump(lane)
    }
    const fail = () => {
      this.lanes = this.lanes.filter((value) => value !== lane)
      lane.active = undefined
      lane.queue.length = 0
      Array.from(lane.ports.values()).forEach((port) => port.onerror?.(new ErrorEvent("error")))
      worker.terminate()
    }
    worker.onerror = (event) => {
      event.preventDefault()
      fail()
    }
    worker.addEventListener("close", () => {
      if (lane.ports.size) fail()
    })
    this.lanes.push(lane)
    return lane
  }

  private pump(lane: Lane) {
    if (lane.active) return
    const request = lane.queue.shift()
    if (!request) {
      lane.worker.unref?.()
      return
    }
    lane.active = request
    lane.worker.ref?.()
    try {
      lane.worker.postMessage(request)
    } catch {
      lane.active = undefined
      lane.ports.get(request.pickerID ?? 0)?.onerror?.(new ErrorEvent("error"))
      this.pump(lane)
    }
  }
}

type Lane = {
  worker: Worker & Pick<Transport, "ref" | "unref">
  ports: Map<number, Transport>
  active?: Request
  queue: Request[]
}

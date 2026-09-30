import { FffError, formatGrep } from "./fff-types"
import type { Request, Response } from "./fff-types"
import type { FileFinder } from "@ff-labs/fff-bun"

declare const self: {
  onmessage: (event: MessageEvent<Request>) => void
  postMessage: (response: Response) => void
}

let picker: FileFinder | undefined

async function run(request: Request) {
  if (request.op === "init") {
    if (picker) throw new FffError("defect", "fff already initialized")
    const { FileFinder } = await import("@ff-labs/fff-bun").catch(() => {
      throw new FffError("unavailable", "fff library could not load")
    })
    if (!FileFinder.isAvailable()) throw new FffError("unavailable", "fff library unavailable")
    const result = FileFinder.create(request.args[0])
    if (!result.ok) throw new FffError("unavailable", "fff picker could not initialize")
    picker = result.value
    return { backend: "fff-worker" as const, workerPath: import.meta.url }
  }
  if (request.op === "dispose") {
    const owned = picker
    owned?.destroy()
    picker = undefined
    return { destroyed: owned?.isDestroyed ?? false }
  }
  if (!picker) throw new FffError("defect", "fff not initialized")
  const result = await (() => {
    switch (request.op) {
      case "fileSearch":
        return picker.fileSearch(...request.args)
      case "glob":
        return picker.glob(...request.args)
      case "directorySearch":
        return picker.directorySearch(...request.args)
      case "mixedSearch":
        return picker.mixedSearch(...request.args)
      case "waitForScan":
        return picker.waitForScan(...request.args)
      case "grep":
        return picker.grep(request.args[0], request.args[1])
    }
  })()
  if (!result.ok) throw new FffError("query", result.error)
  if (request.op !== "grep" || !request.args[2]) return result.value
  // Decode byte-based ranges and truncate UTF-16 text on the worker. Native
  // result memory has already been copied/freed by fff before reaching here.
  if (typeof result.value !== "object" || !("nextCursor" in result.value)) {
    throw new FffError("defect", "invalid grep result")
  }
  return formatGrep(result.value)
}

// The parent sends only one operation at a time, including async init and scan
// readiness. No cancel message can preempt a synchronous native call.
self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data
  const response: Response = await run(request).then(
    (value) => ({ id: request.id, ok: true, value }),
    (error: unknown) => ({
      id: request.id,
      ok: false,
      error:
        error instanceof FffError
          ? { kind: error.kind, message: error.message }
          : { kind: "defect", message: "fff worker operation failed" },
    }),
  )
  self.postMessage(response)
  // The parent terminates this idle worker after receiving the destruction
  // acknowledgement. Bun does not provide WorkerGlobalScope.close().
}

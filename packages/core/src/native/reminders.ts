import { CString, dlopen, FFIType, ptr } from "bun:ffi"
import { nativeLibrary } from "./artifact"

export type Reminder = { id: number; title: string; due: number; completed: number | null }
export type Parsed = { title: string; due: number }
export type Snapshot = { reminders: Reminder[]; now: number }
type Request =
  | { op: "poll"; now: number }
  | { op: "parse"; text: string; now: number }
  | { op: "create"; title: string; due: number; now: number }
  | { op: "update"; id: number; title?: string; due?: number; now: number }
  | { op: "complete"; id: number; now: number }
  | { op: "snooze"; id: number; due: number; now: number }
  | { op: "delete"; id: number }

function load() {
  const library = nativeLibrary()
  if (!library)
    throw new Error("Native reminders are unavailable for this platform. Build the native reminder library first.")
  const binding = dlopen(library, {
    oc_abi_version_v1: { args: [], returns: FFIType.u32 },
    oc_reminders_open_v1: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
    oc_reminders_call_v1: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
    oc_reminders_close_v1: { args: [FFIType.ptr], returns: FFIType.void },
    oc_result_data_v1: { args: [FFIType.ptr], returns: FFIType.ptr },
    oc_result_len_v1: { args: [FFIType.ptr], returns: FFIType.u32 },
    oc_result_free_v1: { args: [FFIType.ptr], returns: FFIType.void },
  })
  if (binding.symbols.oc_abi_version_v1() !== 1) {
    binding.close()
    throw new Error("Native reminder ABI mismatch")
  }
  return binding
}

// A library stays loaded for the isolate lifetime; store handles are independently
// owned. No native pointer or borrowed result buffer escapes a synchronous call.
let binding: ReturnType<typeof load> | undefined

export function open(file: string) {
  const symbols = (binding ??= load()).symbols
  const bytes = Buffer.from(file)
  const handle = symbols.oc_reminders_open_v1(ptr(bytes), bytes.length)
  if (!handle) throw new Error("Could not allocate native reminder store")
  let closed = false

  function call<T>(request: Request): T {
    if (closed) throw new Error("Reminder store is closed")
    const bytes = Buffer.from(JSON.stringify(request))
    if (bytes.length > 65536) throw new Error("Reminder input is too long")
    const result = symbols.oc_reminders_call_v1(handle, ptr(bytes), bytes.length)
    if (!result) throw new Error("Native reminder operation failed")
    try {
      const data = symbols.oc_result_data_v1(result)
      if (!data) throw new Error("Native reminder result is empty")
      const response: { ok: true; value: T } | { ok: false; error: string } = JSON.parse(
        new CString(data, 0, symbols.oc_result_len_v1(result)).toString(),
      )
      if (!response.ok) throw new Error(response.error)
      return response.value
    } finally {
      symbols.oc_result_free_v1(result)
    }
  }

  return {
    poll: (now = Date.now()) => call<Snapshot | null>({ op: "poll", now }),
    parse: (text: string, now = Date.now()) => call<Parsed>({ op: "parse", text, now }),
    create: (reminder: Parsed, now = Date.now()) => call<Reminder>({ op: "create", ...reminder, now }),
    update: (id: number, update: Partial<Parsed>, now = Date.now()) => call<null>({ op: "update", id, ...update, now }),
    complete: (id: number, now = Date.now()) => call<null>({ op: "complete", id, now }),
    snooze: (id: number, due: number, now = Date.now()) => call<null>({ op: "snooze", id, due, now }),
    delete: (id: number) => call<null>({ op: "delete", id }),
    close() {
      if (closed) return
      closed = true
      symbols.oc_reminders_close_v1(handle)
    },
  }
}

export * as NativeReminders from "./reminders"

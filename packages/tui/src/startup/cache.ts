import { rename, unlink } from "node:fs/promises"
import { startupPresentation, type StartupPresentation } from "./presentation"
import { readStartupPresentation } from "./read-presentation"

// One display snapshot, including directory-scoped last-known selection labels.
// No prompt contents, credentials or session data.
// Writers are coalesced and atomic so concurrent processes/readers see a whole
// old or new snapshot. Failure is deliberately invisible to startup and themes.
type Entry = { value: StartupPresentation; ready: boolean; timer?: ReturnType<typeof setTimeout>; write: Promise<void> }
const pending = new Map<string, Entry>()

export function cacheStartupPresentation(state: string, patch: Partial<StartupPresentation>) {
  const entry = pending.get(state) ?? {
    value: readStartupPresentation(startupPresentation, {}, undefined, `${state}/startup-presentation.json`),
    ready: false,
    timer: undefined,
    write: Promise.resolve(),
  }
  const value = startupPresentation({ ...entry.value, ...patch })
  if (entry.ready && JSON.stringify(value) === JSON.stringify(entry.value)) return
  entry.value = value
  entry.ready ||= patch.background !== undefined
  pending.set(state, entry)
  if (!entry.ready) return
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = undefined
    write(state, entry)
  }, 100)
  entry.timer.unref()
}

export async function flushStartupPresentation(state: string) {
  const entry = pending.get(state)
  if (!entry) return
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = undefined
    write(state, entry)
  }
  const active = entry.write
  await active
  if (entry.write === active && !entry.timer && pending.get(state) === entry) pending.delete(state)
}

function write(state: string, entry: Entry) {
  const file = `${state}/startup-presentation.json`
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  const value = { ...entry.value }
  if (Buffer.byteLength(JSON.stringify(value)) > 65536) value.controls = undefined
  if (Buffer.byteLength(JSON.stringify(value)) > 65536 && value.slashes)
    value.slashes = { ...value.slashes, items: value.slashes.items.slice(0, 32) }
  entry.write = entry.write
    .then(() => Bun.write(temporary, JSON.stringify(value)))
    .then(() => rename(temporary, file))
    .catch(() => unlink(temporary).catch(() => {}))
}

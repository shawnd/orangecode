import { Effect } from "effect"

// Per MessageHandler/database scope. Strings are immutable; each response creates
// its own HTTP body, so callers cannot mutate retained bytes through a response.
export const makeTranscriptPageCache = Effect.fn("TranscriptPageCache.make")(function* (
  options = { entries: 16, bytes: 4 * 1024 * 1024, ttl: 10_000 },
) {
  const pages = new Map<
    string,
    { sessionID: string; sequence: number; revision?: string; body: string; bytes: number; expires: number }
  >()
  const size = { bytes: 0 }
  const remove = (key: string) => {
    const page = pages.get(key)
    if (!page) return
    size.bytes -= page.bytes
    pages.delete(key)
  }
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      pages.clear()
      size.bytes = 0
    }),
  )
  return {
    get(key: string, sessionID: string, sequence: number, revision?: string) {
      const now = performance.now()
      pages.forEach((page, key) => {
        if (
          page.expires <= now ||
          (page.sessionID === sessionID && (page.sequence !== sequence || page.revision !== revision))
        )
          remove(key)
      })
      const page = pages.get(key)
      if (!page) return undefined
      pages.delete(key)
      pages.set(key, page)
      return page.body
    },
    set(key: string, sessionID: string, sequence: number, body: string, revision?: string) {
      // Count keys as well as bodies: loose legacy IDs/cursors can be large.
      const bytes = Buffer.byteLength(body, "utf8") + Buffer.byteLength(key, "utf8")
      if (bytes > options.bytes || options.entries <= 0) return
      remove(key)
      while (pages.size >= options.entries || size.bytes + bytes > options.bytes) {
        const oldest = pages.keys().next().value
        if (oldest === undefined) break
        remove(oldest)
      }
      pages.set(key, { sessionID, sequence, revision, body, bytes, expires: performance.now() + options.ttl })
      size.bytes += bytes
    },
  }
})

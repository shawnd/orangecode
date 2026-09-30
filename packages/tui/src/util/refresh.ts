// Join concurrent reads, but remember invalidations that arrive after a read
// started. There is no result cache: a later refresh always reads again.
export function createRefresh() {
  const pending = new Map<string, { dirty: boolean; promise: Promise<void> }>()
  return (key: string, load: () => Promise<void>, invalidate = false) => {
    const active = pending.get(key)
    if (active) {
      if (invalidate) active.dirty = true
      return active.promise
    }
    const entry = {
      dirty: false,
      promise: Promise.resolve().then(async () => {
        try {
          do {
            entry.dirty = false
            const failure = await load().then(
              () => undefined,
              (error: unknown) => ({ error }),
            )
            if (!entry.dirty && failure) throw failure.error
          } while (entry.dirty)
        } finally {
          pending.delete(key)
        }
      }),
    }
    pending.set(key, entry)
    return entry.promise
  }
}

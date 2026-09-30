export function createEventBatch<A>(input: {
  emit: (events: A[]) => void
  size: (event: A) => number
  bytes?: number
  events?: number
}) {
  const budget = { bytes: input.bytes ?? 1024 * 1024, events: input.events ?? 256 }
  let events: A[] = []
  let bytes = 0
  let flushing = false
  let closed = false
  const flush = (prefix?: A[]) => {
    if (flushing || closed) return
    flushing = true
    try {
      if (prefix) input.emit(prefix)
      while (events.length) {
        const pending = events
        events = []
        bytes = 0
        input.emit(pending)
      }
    } finally {
      flushing = false
    }
  }
  return {
    get length() {
      return events.length
    },
    get bytes() {
      return bytes
    },
    flush: () => flush(),
    offer(event: A) {
      if (closed) return false
      const size = input.size(event)
      if (!flushing && (events.length >= budget.events || bytes + size > budget.bytes)) {
        // Synchronous flushing applies the entire ordered prefix, rather than
        // dropping deltas or requiring a snapshot for an ordinary burst.
        // Admit this event before calling consumers: a reentrant offer must
        // follow it, even when this offer is what triggered the early flush.
        const prefix = events
        events = [event]
        bytes = size
        flush(prefix)
        return true
      }
      // A consumer can synchronously reenter an injected EventSource. Keep that
      // tail ordered until its current prefix finishes; throwing or recursively
      // delivering it would lose/reorder events. Budgets apply to the ordinary
      // non-reentrant SSE producer; a reentrant tail is drained by the outer flush.
      events.push(event)
      bytes += size
      // Oversize singleton is delivered directly, never retained behind a timer.
      if (size > budget.bytes) flush()
      return true
    },
    close() {
      closed = true
      events = []
      bytes = 0
    },
  }
}

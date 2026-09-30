import path from "path"
import { Flock } from "@opencode-ai/core/util/flock"

// Apply operations to fresh disk state under a process-shared lock. Pending
// operations remain visible while initial loading and writes are in flight.
export function createPersistentState<T>(input: {
  file: string
  initial: T
  read: () => Promise<T>
  write: (value: T) => Promise<void>
  onChange: (value: T) => void
  onError: (error: unknown) => void
}) {
  let saved = input.initial
  const pending: ((value: T) => T)[] = []
  let queue = Promise.resolve()
  let closed = false

  function publish() {
    if (!closed) input.onChange(pending.reduce((value, change) => change(value), saved))
  }

  function locked<A>(run: () => Promise<A>) {
    return Flock.withLock(`tui-state:${path.resolve(input.file)}`, run, {
      dir: path.join(path.dirname(input.file), "locks"),
    })
  }

  const ready = queue.then(() =>
    locked(async () => {
      saved = await input.read()
      await input.write(saved)
      publish()
    }),
  )
  queue = ready.catch(input.onError)

  return {
    ready,
    update(change: (value: T) => T) {
      if (closed) return Promise.reject(new Error("Persistent state is closed"))
      pending.push(change)
      publish()
      const next = queue.then(async () => {
        const result = await locked(async () => {
          const value = change(await input.read())
          await input.write(value)
          return value
        }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        pending.shift()
        if ("value" in result) saved = result.value
        publish()
        if ("error" in result) throw result.error
      })
      queue = next.catch(input.onError)
      return next
    },
    dispose() {
      closed = true
      return queue
    },
  }
}

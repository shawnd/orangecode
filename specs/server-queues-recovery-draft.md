# Withdrawn QUEUES recovery sketch

This records the uncommitted draft from the first attempt. It is evidence, not
runtime code or an integration proposal. The TUI opt-in and callbacks were
removed during continuation. A quiet client receive window is **not** a shared
snapshot/live cursor fence: data may still be buffered in the server or network.
There are no authoritative legacy/V2 owners here, no location-aware pending
approval hydration, and no fence for preexisting in-flight hydration. Do not use
this sketch to justify automatic reconnect after a gap.

```ts
export function createEventRecovery(input: { commit: (commits: (() => void)[]) => void; ready?: () => boolean }) {
  const handlers = new Set<() => Promise<() => void>>()
  let revision = 0
  let closed = false
  let task: Promise<void> | undefined
  return {
    invalidate() {
      revision++
    },
    subscribe(handler: () => Promise<() => void>) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    close() {
      closed = true
      handlers.clear()
      revision++
    },
    recover() {
      if (task) return task
      task = (async () => {
        if (handlers.size === 0) throw new Error("Event gap has no authoritative recovery owner")
        for (let attempt = 0; attempt < 3; attempt++) {
          const start = revision
          const commits = await Promise.all([...handlers].map((handler) => handler()))
          if (closed) return
          if (start !== revision) continue
          if (input.ready && !input.ready()) throw new Error("Event recovery lost its live subscription")
          input.commit(commits)
          return
        }
        throw new Error("Event recovery could not obtain a quiet authoritative snapshot; reconnect required")
      })().finally(() => {
        task = undefined
      })
      return task
    },
  }
}
```

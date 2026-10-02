import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { Flag } from "@opencode-ai/core/flag/flag"
import { createSimpleContext } from "./helper"
import { batch, onCleanup, onMount } from "solid-js"
import { createEventBatch } from "./event-batch"
import { createSessionInterest } from "./session-interest"
import { scheduler } from "node:timers/promises"

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

export type AttachConnection = {
  url: string
  headers?: RequestInit["headers"]
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
    onAttach?: () => Promise<AttachConnection>
  }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined
    let unsubscribe: (() => void) | undefined
    const selective = process.env.OPENCODE_EXPERIMENTAL_EVENT_INTEREST === "1"
    const interest = createSessionInterest(selective)
    let mounted = false
    let subscription: string | undefined
    let ready = Promise.withResolvers<void>()
    let listening = Promise.withResolvers<void>()
    let epoch = 0
    const recoveries = new Set<(epoch: number) => Promise<void>>()

    function resetConnection() {
      epoch++
      ready.resolve()
      listening.resolve()
      ready = Promise.withResolvers<void>()
      listening = Promise.withResolvers<void>()
    }

    function createSDK() {
      return createOpencodeClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: props.directory,
        fetch: Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init)
            // Register before dispatch: approvals can arrive before the submission response.
            // Creating, attaching, listing and hydrating a Session are view-only operations.
            const submission =
              request.method === "POST" &&
              new URL(request.url).pathname.match(
                /^\/(?:api\/session\/([^/]+)\/(?:prompt|shell|compact)|session\/([^/]+)\/(?:message|prompt_async|shell|command))$/,
              )
            if (submission) {
              request.signal.throwIfAborted()
              const sessionID = decodeURIComponent(submission[1] ?? submission[2])
              const release = interest.holdSubmission(sessionID)
              try {
                interest.control(sessionID)
                while (true) {
                  const current = await waitReady(false, request.signal)
                  request.signal.throwIfAborted()
                  if (current !== epoch) continue
                  return (props.fetch ?? fetch)(request)
                }
              } finally {
                release()
              }
            }
            request.signal.throwIfAborted()
            return (props.fetch ?? fetch)(request)
          },
          { preconnect: fetch.preconnect },
        ),
        headers: props.headers,
      })
    }

    let sdk = createSDK()
    let globalSDK: ReturnType<typeof createOpencodeClient> | undefined

    const handlers = new Set<(event: GlobalEvent) => void>()
    const emitter = {
      emit(_type: "event", event: GlobalEvent) {
        for (const handler of handlers) handler(event)
      },
      on(_type: "event", handler: (event: GlobalEvent) => void) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
    }

    const queue = createEventBatch<GlobalEvent>({
      size: (event) => Buffer.byteLength(JSON.stringify(event)),
      emit: (events) => batch(() => events.forEach((event) => emitter.emit("event", event))),
    })
    let timer: Timer | undefined
    let last = 0
    const retryDelay = 1000
    const maxRetryDelay = 30000

    const flush = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      if (queue.length === 0) return
      last = Date.now()
      queue.flush()
    }

    const handleEvent = (event: GlobalEvent, failed?: () => void) => {
      if (abort.signal.aborted) return
      if (event.payload.type === "server.connected") {
        if (props.events) resetConnection()
        for (const session of event.payload.properties.sessions ?? [])
          interest.observe({ id: session.id, parentID: session.parentID ?? undefined }, false)
        const current = epoch
        const completion = ready
        listening.resolve()
        // Recovery reads wait for the transport, never for submission readiness.
        // Continue consuming SSE while snapshots are held so live updates can win.
        flush()
        void Promise.all([...recoveries].map((recover) => recover(current)))
          .then(() => {
            if (epoch === current) completion.resolve()
          })
          .catch((error) => {
            console.error("Failed to recover event connection:", error)
            if (epoch === current && !abort.signal.aborted) failed?.()
          })
      }
      if (event.payload.type === "session.created" || event.payload.type === "session.updated")
        interest.observe(event.payload.properties.info)
      if (event.payload.type === "session.deleted") {
        // Apply older batched updates before pruning so they cannot restore the deleted cache.
        flush()
        interest.remove(event.payload.properties.info.id)
      }
      if (event.payload.type === "session.status")
        interest.status(event.payload.properties.sessionID, event.payload.properties.status.type !== "idle")
      if (!queue.offer(event)) return
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    function startSSE() {
      flush()
      sse?.abort()
      resetConnection()
      subscription = interest.query()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        let attempt = 0
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break

          await (async () => {
            const connection = new AbortController()
            const events = await sdk.global.event({
              ...(selective ? { sessions: interest.query() } : {}),
              signal: AbortSignal.any([ctrl.signal, connection.signal]),
              sseMaxRetryAttempts: 0,
            })

            if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
              // Start syncing workspaces, it's important to do this after
              // we've started listening to events
              await sdk.sync.start().catch(() => {})
            }

            for await (const event of events.stream) {
              if (ctrl.signal.aborted) break
              if (event.payload.type === "server.connected") attempt = 0
              handleEvent(event, () => connection.abort())
            }
          })().catch(() => {})

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          if (sse === ctrl && !ctrl.signal.aborted) resetConnection()
          attempt += 1
          if (abort.signal.aborted || ctrl.signal.aborted) break

          // Exponential backoff
          const backoff = Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
          await scheduler.wait(backoff, { signal: ctrl.signal }).catch(() => {})
        }
      })().catch(() => {})
    }

    onMount(async () => {
      mounted = true
      if (props.events) {
        const cleanup = await props.events.subscribe(handleEvent)
        // subscribe may finish after the provider is disposed. Registering
        // onCleanup after await also loses Solid's synchronous owner.
        if (abort.signal.aborted) {
          cleanup()
          return
        }
        unsubscribe = cleanup
        if (epoch === 0) {
          listening.resolve()
          ready.resolve()
        }

        if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
          // Start syncing workspaces, it's important to do this after
          // we've started listening to events
          await sdk.sync.start().catch(() => {})
        }
      } else {
        startSSE()
      }
    })
    onCleanup(
      interest.onChange(() => {
        if (selective && mounted && !props.events && subscription !== interest.query()) startSSE()
      }),
    )

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      unsubscribe?.()
      ready.resolve()
      listening.resolve()
      if (timer) clearTimeout(timer)
      handlers.clear()
      queue.close()
    })

    async function waitReady(transport: boolean, signal?: AbortSignal) {
      const cancellation = AbortSignal.any([abort.signal, ...(signal ? [signal] : [])])
      cancellation.throwIfAborted()
      const stopped = Promise.withResolvers<never>()
      const cancel = () => stopped.reject(cancellation.reason)
      cancellation.addEventListener("abort", cancel, { once: true })
      try {
        while (true) {
          const current = transport ? listening : ready
          await Promise.race([current.promise, stopped.promise])
          cancellation.throwIfAborted()
          if (current !== (transport ? listening : ready)) continue
          flush()
          cancellation.throwIfAborted()
          if (current !== (transport ? listening : ready)) continue
          return epoch
        }
      } finally {
        cancellation.removeEventListener("abort", cancel)
      }
    }

    async function eventsReady(signal?: AbortSignal) {
      await waitReady(false, signal)
    }

    return {
      get client() {
        return sdk
      },
      get globalClient() {
        return (globalSDK ??= createOpencodeClient({
          baseUrl: props.url,
          signal: abort.signal,
          fetch: props.fetch,
          headers: props.headers,
        }))
      },
      directory: props.directory,
      event: emitter,
      interest,
      selective,
      eventsReady,
      streamReady: (signal?: AbortSignal) => waitReady(true, signal),
      get connectionEpoch() {
        return epoch
      },
      onRecovery(recover: (epoch: number) => Promise<void>) {
        recoveries.add(recover)
        return () => recoveries.delete(recover)
      },
      flushEvents: flush,
      // Explicit adoption is client-local. A second attached client starts view-only.
      adoptSession(sessionID: string) {
        interest.control(sessionID)
      },
      fetch: props.fetch ?? fetch,
      url: props.url,
      async attachConnection(): Promise<AttachConnection> {
        if (props.onAttach) return props.onAttach()
        if (props.fetch) throw new Error("This TUI connection cannot be shared with another pane")
        return { url: props.url, headers: props.headers }
      },
    }
  },
})

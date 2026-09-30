import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { Flag } from "@opencode-ai/core/flag/flag"
import { createSimpleContext } from "./helper"
import { batch, onCleanup, onMount } from "solid-js"
import { createEventBatch } from "./event-batch"
import { createSessionInterest } from "./session-interest"

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
    let ready = Promise.withResolvers<void>()

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
              interest.control(decodeURIComponent(submission[1] ?? submission[2]))
              if (selective) await eventsReady()
            }
            return (props.fetch ?? fetch)(request)
          },
          { preconnect: fetch.preconnect },
        ),
        headers: props.headers,
      })
    }

    let sdk = createSDK()

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

    const handleEvent = (event: GlobalEvent) => {
      if (event.payload.type === "server.connected") {
        for (const session of event.payload.properties.sessions ?? [])
          interest.observe({ id: session.id, parentID: session.parentID ?? undefined }, false)
        ready.resolve()
      }
      if (event.payload.type === "session.created" || event.payload.type === "session.updated")
        interest.observe(event.payload.properties.info)
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
      ready.resolve()
      ready = Promise.withResolvers<void>()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        let attempt = 0
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break

          const events = await sdk.global.event({
            ...(selective ? { sessions: interest.query() } : {}),
            signal: ctrl.signal,
            sseMaxRetryAttempts: 0,
          })

          if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
            // Start syncing workspaces, it's important to do this after
            // we've started listening to events
            await sdk.sync.start().catch(() => {})
          }

          for await (const event of events.stream) {
            if (ctrl.signal.aborted) break
            handleEvent(event)
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          attempt += 1
          if (abort.signal.aborted || ctrl.signal.aborted) break

          // Exponential backoff
          const backoff = Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
          await new Promise((resolve) => setTimeout(resolve, backoff))
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
        ready.resolve()

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
        if (selective && mounted && !props.events) startSSE()
      }),
    )

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      unsubscribe?.()
      ready.resolve()
      if (timer) clearTimeout(timer)
      handlers.clear()
      queue.close()
    })

    async function eventsReady() {
      while (!abort.signal.aborted) {
        const current = ready
        await current.promise
        if (current === ready) {
          flush()
          return
        }
      }
    }

    return {
      get client() {
        return sdk
      },
      directory: props.directory,
      event: emitter,
      interest,
      selective,
      eventsReady,
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

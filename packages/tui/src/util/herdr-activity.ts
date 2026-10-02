import type { SessionWorkStateInfo } from "@opencode-ai/sdk/v2"
import { Option, Schema } from "effect"

const decodeReply = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      result: Schema.Unknown,
      error: Schema.optional(Schema.Unknown),
    }),
  ),
)

/** Keep polling after foreground idle: detached jobs do not emit foreground status. */
export function createHerdrActivityReporter(input: {
  current: () => string | undefined
  read: (sessionID: string, signal: AbortSignal) => Promise<SessionWorkStateInfo>
  paneID: string
  socketPath: string
  interval?: number
}) {
  let disposed = false
  let sequence = Date.now() * 1000
  let selected:
    | {
        id: string
        controller: AbortController
        pending: boolean
        reported: boolean
        reportedAt: number
        retryAt: number
        retryIndex: number
        retry?: ReturnType<typeof setTimeout>
        state?: SessionWorkStateInfo["type"]
      }
    | undefined

  async function refresh() {
    if (disposed) return
    const id = input.current()
    if (id !== selected?.id) {
      selected?.controller.abort()
      clearTimeout(selected?.retry)
      selected = id
        ? {
            id,
            controller: new AbortController(),
            pending: false,
            reported: false,
            reportedAt: 0,
            retryAt: 0,
            retryIndex: 0,
          }
        : undefined
    }
    const selection = selected
    if (!selection || selection.pending) return
    selection.pending = true
    const current = () => !disposed && selected === selection && input.current() === selection.id
    const activity = await input.read(selection.id, selection.controller.signal).catch(() => undefined)
    if (!activity || !current()) {
      selection.pending = false
      return
    }
    if (!selection.reported || Date.now() >= selection.retryAt) {
      selection.reported = await send(
        input,
        {
          method: "pane.report_agent_session",
          params: { agent_session_id: selection.id, session_start_source: "select" },
        },
        selection.controller.signal,
        current,
      )
      if (selection.reported && current()) {
        // Herdr also acknowledges selections ignored before foreground detection.
        // Match its installed integration's bounded startup reconciliation retries.
        const delay = [100, 400, 1000][selection.retryIndex++]
        selection.retryAt = delay === undefined ? Infinity : Date.now() + delay
        clearTimeout(selection.retry)
        selection.retry =
          delay === undefined
            ? undefined
            : setTimeout(() => {
                if (current()) void refresh()
              }, delay)
        // Replay state after reselect: an earlier acknowledged state may be ignored too.
        selection.reportedAt = 0
      }
      // Selection can wait on IPC. Never publish the snapshot from before that wait.
      selection.pending = false
      if (selection.reported && current()) void refresh()
      return
    }
    if (current() && (selection.state !== activity.type || Date.now() - selection.reportedAt >= 1000)) {
      // The TUI owns attribution; newer sequences supersede older foreground-only hooks.
      sequence = Math.max(sequence + 1, Date.now() * 1000)
      const sent = await send(
        input,
        {
          method: "pane.report_agent",
          params: { agent_session_id: selection.id, state: activity.type, seq: sequence },
        },
        selection.controller.signal,
        current,
      )
      if (sent && current()) {
        selection.state = activity.type
        selection.reportedAt = Date.now()
      }
    }
    selection.pending = false
  }

  const poll = setInterval(() => void refresh(), input.interval ?? 250)
  void refresh()
  return () => {
    disposed = true
    clearInterval(poll)
    selected?.controller.abort()
    clearTimeout(selected?.retry)
  }
}

async function send(
  target: { paneID: string; socketPath: string },
  request: { method: string; params: Record<string, string | number> },
  signal: AbortSignal,
  current: () => boolean,
) {
  const { createConnection } = await import("node:net")
  if (signal.aborted || !current()) return false
  return new Promise<boolean>((resolve) => {
    const id = crypto.randomUUID()
    const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${target.socketPath}` : target.socketPath
    const client = createConnection(endpoint, () => {
      if (signal.aborted || !current()) return finish(false)
      client.write(
        JSON.stringify({
          id,
          method: request.method,
          params: { pane_id: target.paneID, source: "herdr:opencode", agent: "opencode", ...request.params },
        }) + "\n",
      )
    })
    const timeout = setTimeout(() => finish(false), 500)
    timeout.unref()
    const abort = () => finish(false)
    const finish = (sent: boolean) => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
      client.destroy()
      resolve(sent)
    }
    signal.addEventListener("abort", abort, { once: true })
    let response = ""
    client.on("data", (buffer) => {
      response += buffer.toString()
      const end = response.indexOf("\n")
      if (end < 0) return
      const reply = decodeReply(response.slice(0, end))
      finish(
        Option.isSome(reply) &&
          (reply.value.id === undefined || reply.value.id === id) &&
          (reply.value.error === undefined || reply.value.error === null),
      )
    })
    client.once("error", () => finish(false))
    client.once("end", () => finish(false))
    client.once("close", () => finish(false))
  })
}

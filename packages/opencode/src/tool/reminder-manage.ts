import path from "node:path"
import { Effect, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { NativeReminders } from "@opencode-ai/core/native/reminders"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Tool } from "./tool"
import { ToolJsonSchema } from "./json-schema"

const ID = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
  description: "Reminder ID returned by reminder_create or reminder_list",
})
const Name = Schema.Struct({ id: ID })
const Time = Schema.String.annotate({
  description: "Natural-language local time, e.g. ‘in 10 minutes’ or ‘tomorrow at 9am’",
})
const Create = Schema.Struct({
  text: Schema.String.annotate({ description: "Reminder time and message, e.g. ‘in 20 minutes check the build’" }),
})
const List = Schema.Struct({
  status: Schema.optional(Schema.Literals(["all", "due", "upcoming", "addressed"])).annotate({
    description: "Filter by status; defaults to all",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Case-insensitive text to match in the reminder message",
  }),
})
const Update = Schema.Struct({
  id: ID,
  title: Schema.optional(Schema.String).annotate({ description: "New reminder message" }),
  when: Schema.optional(Time),
})
const Snooze = Schema.Struct({ id: ID, when: Time })

export const ReminderManagementTools = Effect.gen(function* () {
  const global = yield* Global.Service
  const fs = yield* FSUtil.Service

  const managed = <P extends Schema.Decoder<unknown>>(
    id: string,
    description: string,
    parameters: P,
    run: (params: Schema.Schema.Type<P>, store: ReturnType<typeof NativeReminders.open>) => unknown,
  ) =>
    Tool.define(
      id,
      Effect.succeed({
        description,
        parameters,
        execute: (params: Schema.Schema.Type<P>, ctx: Tool.Context) =>
          Effect.gen(function* () {
            yield* ctx.ask({ permission: id, patterns: ["*"], always: ["*"], metadata: { input: params } })
            yield* fs.makeDirectory(global.state, { recursive: true })
            const { NativeReminders } = yield* Effect.promise(() => import("@opencode-ai/core/native/reminders"))
            const store = yield* Effect.acquireRelease(
              Effect.try({
                try: () => NativeReminders.open(path.join(global.state, "reminders.sqlite3")),
                catch: reminderError,
              }),
              (store) => Effect.sync(() => store.close()),
            )
            const result = yield* Effect.try({ try: () => run(params, store), catch: reminderError })
            return { title: id, output: JSON.stringify(result, null, 2), metadata: { operation: id } }
          }).pipe(Effect.scoped, Effect.orDie),
      }),
    )

  const list = yield* managed(
    "reminder_list",
    "List shared reminders across all local TUI instances, including IDs, messages, due timestamps, local due times, and status. Optionally filter by status or message. Reminders persist across restarts.",
    List,
    (params, store) => {
      const snapshot = store.poll()
      if (!snapshot) throw new Error("Could not read reminder snapshot")
      return snapshot.reminders
        .map((item) => ({
          ...item,
          status: item.completed !== null ? "addressed" : item.due <= snapshot.now ? "due" : "upcoming",
          dueLocal: new Date(item.due).toLocaleString(),
        }))
        .filter(
          (item) =>
            (!params.status || params.status === "all" || params.status === item.status) &&
            (!params.query || item.title.toLowerCase().includes(params.query.toLowerCase())),
        )
    },
  )
  const create = yield* managed(
    "reminder_create",
    "Schedule a shared reminder from natural text. Creates it immediately and returns its ID, message, and due time. Due reminders remain visible in all open local TUIs until addressed, snoozed, or deleted. This notifies the user; it does not wake or schedule agent execution.",
    Create,
    (params, store) => {
      const reminder = store.create(store.parse(params.text))
      return { ...reminder, dueLocal: new Date(reminder.due).toLocaleString() }
    },
  )
  const update = yield* managed(
    "reminder_update",
    "Edit a reminder's message, scheduled time, or both. Provide title and/or when. Preserves its addressed status; use reminder_snooze to reactivate an addressed reminder.",
    Update,
    (params, store) => {
      store.update(params.id, {
        title: params.title,
        due: params.when !== undefined ? store.parse(`${params.when} reminder`).due : undefined,
      })
      return { updated: true, id: params.id }
    },
  )
  const complete = yield* managed(
    "reminder_complete",
    "Mark a reminder addressed. Removes its due notification from all local TUIs while preserving it in addressed history.",
    Name,
    (params, store) => {
      store.complete(params.id)
      return { addressed: true, id: params.id }
    },
  )
  const snooze = yield* managed(
    "reminder_snooze",
    "Snooze or reschedule a reminder to a future natural-language time. Clears its addressed status, so this also reactivates an addressed reminder. The change applies across all local TUIs.",
    Snooze,
    (params, store) => {
      const due = store.parse(`${params.when} reminder`).due
      store.snooze(params.id, due)
      return { id: params.id, due, dueLocal: new Date(due).toLocaleString(), snoozed: true }
    },
  )
  const remove = yield* managed(
    "reminder_delete",
    "Permanently delete a reminder and its notification from the shared store and every local TUI.",
    Name,
    (params, store) => {
      store.delete(params.id)
      return { deleted: true, id: params.id }
    },
  )
  const management: Tool.Info[] = [list, create, update, complete, snooze, remove]
  const discovery = yield* Tool.define(
    "reminder_tools",
    Effect.succeed({
      description:
        "Show all available reminder tools and their input schemas, and load them for the next model turn of the current user request. Call this first to create, inspect, edit, acknowledge, snooze, reschedule, reactivate, or delete shared reminders.",
      parameters: Schema.Struct({}),
      execute: () =>
        Effect.gen(function* () {
          const tools = yield* Effect.forEach(management, (tool) => Tool.init(tool))
          return {
            title: "Reminder tools",
            output:
              "These tools are available on the next model turn for this user request. They control the same persistent reminders shown in all local TUIs.\n" +
              JSON.stringify(
                tools.map((tool) => ({
                  name: tool.id,
                  description: tool.description,
                  parameters: ToolJsonSchema.fromTool(tool),
                })),
                null,
                2,
              ),
            metadata: { reminderManagement: true },
          }
        }),
    }),
  )
  const tools: Tool.Info[] = [discovery, ...management]
  return tools
})

function reminderError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

export function reminderManagementRequested(messages: SessionV1.WithParts[]) {
  const index = messages.findLastIndex((message) => message.info.role === "user")
  if (index < 0) return false
  const user = messages[index].info
  return messages
    .slice(index + 1)
    .some(
      (message) =>
        message.info.role === "assistant" &&
        message.info.parentID === user.id &&
        message.info.sessionID === user.sessionID &&
        message.parts.some(
          (part) =>
            part.type === "tool" &&
            part.tool === "reminder_tools" &&
            part.state.status === "completed" &&
            part.state.metadata.reminderManagement === true,
        ),
    )
}

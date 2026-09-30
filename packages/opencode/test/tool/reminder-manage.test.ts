import path from "node:path"
import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { NativeReminders } from "@opencode-ai/core/native/reminders"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { ReminderManagementTools } from "@/tool/reminder-manage"
import { MessageID, SessionID } from "@/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Agent.node, Truncate.node, FSUtil.node, Global.node])))

function context(permissions: string[] = []): Tool.Context {
  return {
    sessionID: SessionID.create(),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.sync(() => {
        permissions.push(request.permission)
      }),
  }
}

afterEach(async () => {
  await disposeAllInstances()
})

describe("agent reminder tools", () => {
  it.instance("discovers all tools and manages the same native store used by the TUI", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const infos = yield* ReminderManagementTools.pipe(
        Effect.provideService(Global.Service, Global.make({ state: test.directory })),
      )
      const tools = yield* Effect.forEach(infos, (tool) => Tool.init(tool))
      const permissions: string[] = []
      const ctx = context(permissions)
      const execute = (name: string, params: unknown) => {
        const tool = tools.find((tool) => tool.id === name)
        if (!tool) throw new Error(`Missing ${name}`)
        return tool.execute(params, ctx)
      }
      const discovered = yield* execute("reminder_tools", {})
      expect(discovered.metadata.reminderManagement).toBe(true)
      for (const name of [
        "reminder_list",
        "reminder_create",
        "reminder_update",
        "reminder_complete",
        "reminder_snooze",
        "reminder_delete",
      ]) {
        expect(discovered.output).toContain(name)
      }
      expect(discovered.output).toContain('"parameters"')
      expect(discovered.output).toContain('"required"')

      const observer = yield* Effect.acquireRelease(
        Effect.sync(() => NativeReminders.open(path.join(test.directory, "reminders.sqlite3"))),
        (store) => Effect.sync(() => store.close()),
      )
      expect(observer.poll()?.reminders).toEqual([])
      const created = yield* execute("reminder_create", { text: "in 20 minutes check CI" })
      const reminder = observer.poll()?.reminders[0]
      if (!reminder) throw new Error("Agent reminder not visible in native store")
      expect(reminder.title).toBe("check CI")
      expect(created.output).toContain(`"id": ${reminder.id}`)
      const listed = yield* execute("reminder_list", { status: "upcoming", query: "CI" })
      expect(listed.output).toContain("check CI")
      expect(listed.output).toContain('"status": "upcoming"')
      expect((yield* execute("reminder_list", { status: "due" })).output).toBe("[]")

      yield* execute("reminder_update", { id: reminder.id, title: "review CI", when: "in 1 hour" })
      expect(observer.poll()?.reminders[0].title).toBe("review CI")
      yield* execute("reminder_complete", { id: reminder.id })
      expect(observer.poll()?.reminders[0].completed).toBeNumber()
      yield* execute("reminder_update", { id: reminder.id, title: "CI addressed" })
      expect(observer.poll()?.reminders[0].completed).toBeNumber()
      expect((yield* execute("reminder_list", { status: "addressed" })).output).toContain("CI addressed")
      yield* execute("reminder_snooze", { id: reminder.id, when: "in 10 minutes" })
      const snoozed = observer.poll()?.reminders[0]
      expect(snoozed?.completed).toBeNull()
      expect(snoozed?.due).toBeGreaterThan(Date.now())
      yield* execute("reminder_delete", { id: reminder.id })
      expect(observer.poll()?.reminders).toEqual([])
      expect(permissions).toContain("reminder_create")
      expect(permissions).toContain("reminder_update")
      expect(permissions).toContain("reminder_delete")
    }),
  )

  it.instance("rejects permission failures and invalid updates without changing reminders", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const infos = yield* ReminderManagementTools.pipe(
        Effect.provideService(Global.Service, Global.make({ state: test.directory })),
      )
      const tools = yield* Effect.forEach(infos, (tool) => Tool.init(tool))
      const create = tools.find((tool) => tool.id === "reminder_create")
      const update = tools.find((tool) => tool.id === "reminder_update")
      const snooze = tools.find((tool) => tool.id === "reminder_snooze")
      if (!create || !update || !snooze) throw new Error("Missing reminder tools")
      const denied = yield* create
        .execute({ text: "in 20 minutes check CI" }, { ...context(), ask: () => Effect.die(new Error("Denied")) })
        .pipe(Effect.exit)
      expect(denied._tag).toBe("Failure")
      const observer = yield* Effect.acquireRelease(
        Effect.sync(() => NativeReminders.open(path.join(test.directory, "reminders.sqlite3"))),
        (store) => Effect.sync(() => store.close()),
      )
      expect(observer.poll()?.reminders).toEqual([])
      const reminder = observer.create(observer.parse("in 20 minutes check CI"))
      for (const input of [
        { id: reminder.id },
        { id: reminder.id, title: " " },
        { id: reminder.id, title: "changed", when: "yesterday" },
        { id: 0, title: "changed" },
      ]) {
        expect((yield* update.execute(input, context()).pipe(Effect.exit))._tag).toBe("Failure")
      }
      expect((yield* snooze.execute({ id: reminder.id, when: "in 0 minutes" }, context()).pipe(Effect.exit))._tag).toBe(
        "Failure",
      )
      const fresh = NativeReminders.open(path.join(test.directory, "reminders.sqlite3"))
      yield* Effect.addFinalizer(() => Effect.sync(() => fresh.close()))
      expect(fresh.poll()?.reminders).toEqual([reminder])
    }),
  )
})

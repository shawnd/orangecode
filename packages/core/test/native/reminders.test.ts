import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { NativeReminders } from "../../src/native/reminders"

test("real Rust FFI shares reminders across processes, survives reopen, and frees handles", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oc-reminders-"))
  const file = path.join(directory, "reminders.sqlite3")
  const store = NativeReminders.open(file)
  try {
    expect(store.poll(1000)?.reminders).toEqual([])
    expect(store.poll(1001)).toBeNull()
    const module = path.resolve(import.meta.dirname, "../../src/native/reminders.ts")
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
      const { NativeReminders } = await import(${JSON.stringify(module)});
      const store = NativeReminders.open(${JSON.stringify(file)});
      store.create({title: "check café 🚀", due: 2000}, 1000);
      store.close();
    `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(await child.exited).toBe(0)
    const snapshot = store.poll(1001)!
    expect(snapshot.reminders).toHaveLength(1)
    expect(snapshot.reminders[0].title).toBe("check café 🚀")
    expect(store.poll(1999)).toBeNull()
    expect(store.poll(2000)?.now).toBe(2000)
    expect(store.poll(2001)).toBeNull()
    store.complete(snapshot.reminders[0].id, 2002)
    expect(store.poll(2003)?.reminders[0].completed).toBe(2002)
    store.close()
    store.close()
    expect(() => store.poll()).toThrow("closed")
    const reopened = NativeReminders.open(file)
    try {
      const reminder = reopened.poll(2004)!.reminders[0]
      expect(reminder.completed).toBe(2002)
      reopened.snooze(reminder.id, 4000, 2004)
      expect(reopened.poll(2005)?.reminders[0].completed).toBeNull()
      reopened.delete(reminder.id)
      expect(reopened.poll(2006)?.reminders).toEqual([])
    } finally {
      reopened.close()
    }
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("native failures return errors and copied results outlive subsequent FFI calls", async () => {
  const store = NativeReminders.open(":memory:")
  try {
    const parsed = store.parse("in twenty minutes check CI")
    expect(parsed.title).toBe("check CI")
    for (let index = 0; index < 1000; index++) {
      expect(store.parse("in 1 hour check the build", 1000).due).toBe(3601000)
    }
    expect(parsed.title).toBe("check CI")
    expect(() => store.parse("take a break")).toThrow("Include a time")
    expect(() => store.parse("x".repeat(70000))).toThrow("too long")
    expect(() => store.create({ title: "", due: 2000 }, 1000)).toThrow("message")
    expect(() => store.create({ title: "past", due: 999 }, 1000)).toThrow("future")
    expect(() => store.snooze(999, 3000, 1000)).toThrow("another terminal")
  } finally {
    store.close()
  }
  const bad = NativeReminders.open("/nonexistent-opencode-reminder-dir/store.sqlite3")
  try {
    expect(() => bad.poll()).toThrow()
  } finally {
    bad.close()
  }
})

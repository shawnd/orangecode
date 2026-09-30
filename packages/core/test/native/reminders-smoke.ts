import { NativeReminders } from "../../src/native/reminders"

const store = NativeReminders.open(":memory:")
try {
  const parsed = store.parse("in 20 minutes check the build", 1000)
  store.create(parsed, 1000)
  const snapshot = store.poll(1000)
  if (snapshot?.reminders[0]?.title !== "check the build" || snapshot.reminders[0].due !== 1201000)
    throw new Error("Embedded reminder backend failed")
  console.log("embedded Rust reminders: OK")
} finally {
  store.close()
}

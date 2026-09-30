import { createMemo, createSignal, onMount } from "solid-js"
import type { NativeReminders } from "@opencode-ai/core/native/reminders"
import { useReminders } from "../context/reminders"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useToast } from "../ui/toast"

export function reminderTime(due: number) {
  return new Date(due).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function DialogReminders() {
  const reminders = useReminders()
  const dialog = useDialog()
  const { theme } = useTheme()
  onMount(() => dialog.setSize("large"))
  const options = createMemo(() => [
    { title: "New reminder…", value: "new" as const, category: "Reminders", description: "Schedule with natural text" },
    ...reminders.snapshot().reminders.map((item) => ({
      title: item.title,
      value: item.id,
      category: item.completed !== null ? "Addressed" : item.due <= reminders.snapshot().now ? "Due now" : "Upcoming",
      details: [
        reminderTime(item.due),
        ...(item.completed !== null ? [`Addressed ${reminderTime(item.completed)}`] : []),
      ],
    })),
  ])
  return (
    <DialogSelect<number | "new">
      title="Reminders · all terminals"
      placeholder="Search reminders"
      options={options()}
      preserveSelection
      footer={
        <text fg={reminders.error() ? theme.error : theme.textMuted}>
          {reminders.error() ?? "Shared across local TUI instances · select a reminder to manage it"}
        </text>
      }
      onSelect={(option) => {
        if (option.value === "new") {
          dialog.replace(() => <DialogReminderCreate />)
          return
        }
        const id = option.value
        dialog.replace(() => <DialogReminderActions id={id} />)
      }}
    />
  )
}

export function DialogReminderCreate(props: { value?: string }) {
  const reminders = useReminders()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [busy, setBusy] = createSignal(false)
  return (
    <DialogPrompt
      title="Schedule a reminder"
      value={props.value}
      busy={busy()}
      busyText="Parsing reminder…"
      placeholder="in 20 minutes check the build"
      description={() => (
        <text fg={theme.textMuted}>
          Try “call Sam tomorrow at 9am” or “in an hour take a break”.{"\n"}You’ll confirm the message and local time
          before scheduling.
        </text>
      )}
      onConfirm={(text) => {
        if (busy()) return
        setBusy(true)
        void reminders
          .parse(text)
          .then((parsed) => {
            dialog.replace(() => <DialogReminderConfirm parsed={parsed} text={text} />)
          })
          .catch(toast.error)
          .finally(() => setBusy(false))
      }}
    />
  )
}

export function DialogReminderConfirm(props: { parsed: NativeReminders.Parsed; text: string }) {
  const reminders = useReminders()
  const dialog = useDialog()
  const toast = useToast()
  const [busy, setBusy] = createSignal(false)
  return (
    <DialogSelect
      title="Confirm reminder"
      locked={busy()}
      options={[
        {
          title: "Schedule reminder",
          value: "schedule",
          description: reminderTime(props.parsed.due),
          details: [props.parsed.title],
        },
        { title: "Edit message or time", value: "edit" },
        { title: "Cancel", value: "cancel" },
      ]}
      onSelect={(option) => {
        if (busy()) return
        if (option.value === "edit") {
          dialog.replace(() => <DialogReminderCreate value={props.text} />)
          return
        }
        if (option.value === "cancel") {
          dialog.clear()
          return
        }
        setBusy(true)
        void reminders
          .create(props.parsed)
          .then(() => {
            toast.show({ variant: "success", message: `Reminder scheduled for ${reminderTime(props.parsed.due)}` })
            dialog.clear()
          })
          .catch(toast.error)
          .finally(() => setBusy(false))
      }}
    />
  )
}

function DialogReminderActions(props: { id: number }) {
  const reminders = useReminders()
  const dialog = useDialog()
  const toast = useToast()
  const item = createMemo(() => reminders.snapshot().reminders.find((item) => item.id === props.id))
  function finish(operation: Promise<unknown>) {
    void operation.then(() => dialog.replace(() => <DialogReminders />)).catch(toast.error)
  }
  return (
    <DialogSelect
      title={item()?.title ?? "Reminder removed"}
      options={
        item()
          ? [
              ...(item()!.completed === null ? [{ title: "Mark addressed", value: "complete" }] : []),
              { title: "Snooze 10 minutes", value: "10" },
              { title: "Snooze 1 hour", value: "60" },
              { title: "Reschedule…", value: "reschedule", description: reminderTime(item()!.due) },
              { title: "Delete reminder", value: "delete" },
              { title: "Back to all reminders", value: "back" },
            ]
          : [{ title: "Back to all reminders", value: "back" }]
      }
      onSelect={(option) => {
        if (option.value === "back") {
          dialog.replace(() => <DialogReminders />)
          return
        }
        if (option.value === "complete") return finish(reminders.complete(props.id))
        if (option.value === "10" || option.value === "60")
          return finish(reminders.snooze(props.id, Date.now() + Number(option.value) * 60000))
        if (option.value === "delete") {
          void DialogConfirm.show(dialog, "Delete reminder?", item()?.title ?? "This reminder").then((confirmed) => {
            if (confirmed) return finish(reminders.delete(props.id))
            dialog.replace(() => <DialogReminderActions id={props.id} />)
          })
          return
        }
        dialog.replace(() => (
          <DialogPrompt
            title="Reschedule reminder"
            placeholder="tomorrow at 9am"
            onConfirm={(text) => {
              void reminders
                .parse(`${text} reminder`)
                .then((parsed) => finish(reminders.snooze(props.id, parsed.due)))
                .catch(toast.error)
            }}
          />
        ))
      }}
    />
  )
}

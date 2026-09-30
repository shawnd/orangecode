import { createMemo, Show } from "solid-js"
import { useReminders } from "../context/reminders"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogReminders } from "./dialog-reminders"

export function ReminderIndicator() {
  const reminders = useReminders()
  const dialog = useDialog()
  const { theme } = useTheme()
  const active = createMemo(() => reminders.snapshot().reminders.filter((item) => item.completed === null))
  const alarming = createMemo(() => active().filter((item) => item.due <= reminders.snapshot().now).length)
  return (
    <text
      fg={alarming() > 0 ? theme.warning : theme.textMuted}
      flexShrink={0}
      wrapMode="none"
      onMouseUp={(event) => {
        event.stopPropagation()
        dialog.replace(() => <DialogReminders />)
      }}
    >
      ◷{" "}
      <Show when={alarming() > 0}>
        <span style={{ fg: theme.warning, bold: true }}>{alarming()}</span>{" "}
      </Show>
      <span style={{ fg: theme.textMuted }}>({active().length})</span>
    </text>
  )
}

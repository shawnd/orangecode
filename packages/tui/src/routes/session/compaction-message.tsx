import { useRenderer } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { PromptInfo } from "../../component/prompt/history"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { DialogMessage } from "./dialog-message"

export function CompactionMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const renderer = useRenderer()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)

  return (
    <box
      id={props.messageID}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        dialog.replace(() => (
          <DialogMessage messageID={props.messageID} sessionID={props.sessionID} setPrompt={props.setPrompt} />
        ))
      }}
      marginTop={1}
      border={["top"]}
      title=" Compaction "
      titleAlignment="center"
      borderColor={hover() ? theme.text : theme.borderActive}
    />
  )
}

import type { TextareaRenderable } from "@opentui/core"
import { promptOffsetWidth } from "./display"

export function adoptEarlyDraft(input: TextareaRenderable, draft: { text: string; cursor: number }) {
  if (!draft.text) return input.plainText
  // Keep restored contents and attachment extmarks. Startup text is appended
  // rather than replacing an unsaved prompt, and is never submitted here.
  input.gotoBufferEnd()
  const prefix = input.plainText ? "\n" : ""
  const offset = input.cursorOffset
  input.insertText(prefix + draft.text)
  input.cursorOffset = offset + promptOffsetWidth(prefix + draft.text.slice(0, draft.cursor))
  return input.plainText
}

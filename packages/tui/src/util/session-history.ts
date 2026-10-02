import type { Message, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"

export function messagesBeforeRevert(messages: readonly Message[], messageID?: string) {
  if (!messageID) return messages
  const index = messages.findIndex((message) => message.id === messageID)
  return index < 0 ? messages : messages.slice(0, index)
}

export function undoableMessages(messages: readonly Message[], parts: Record<string, Part[]>) {
  return messages.filter((message): message is UserMessage => {
    if (message.role !== "user") return false
    const content = parts[message.id] ?? []
    // Compaction markers are undoable; internal continuation prompts are not separate inputs.
    return content.length === 0 || !content.every((part) => part.type === "text" && part.synthetic)
  })
}

export function shouldAbortForUndo(messages: readonly Message[], messageID: string, status?: SessionStatus) {
  if (status?.type === "idle") return false
  const assistant = messages.findLastIndex((message) => message.role === "assistant")
  return assistant < 0 || messages.findIndex((message) => message.id === messageID) <= assistant
}

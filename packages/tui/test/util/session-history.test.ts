import { describe, expect, test } from "bun:test"
import type { Message, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { messagesBeforeRevert, shouldAbortForUndo, undoableMessages } from "../../src/util/session-history"

const user = (id: string, created: number): UserMessage => ({
  id,
  role: "user",
  sessionID: "session",
  time: { created },
  agent: "build",
  model: { providerID: "test", modelID: "test" },
})

const messages: Message[] = [user("msg_z-user", 1), user("msg_a-compact", 2), user("msg_b-continue", 3)]
const parts: Record<string, Part[]> = {
  "msg_z-user": [{ id: "part1", sessionID: "session", messageID: "msg_z-user", type: "text", text: "Help me" }],
  "msg_a-compact": [{ id: "part2", sessionID: "session", messageID: "msg_a-compact", type: "compaction", auto: false }],
  "msg_b-continue": [
    { id: "part3", sessionID: "session", messageID: "msg_b-continue", type: "text", text: "Continue", synthetic: true },
  ],
}

describe("session undo history", () => {
  test("queued undo skips abort while undoing an active turn requests it", () => {
    const assistant: Message = {
      id: "msg_assistant",
      role: "assistant",
      sessionID: "session",
      parentID: "msg_z-user",
      time: { created: 2 },
      modelID: "test",
      providerID: "test",
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const history = [messages[0], assistant, user("msg_queued", 3)]
    expect(shouldAbortForUndo(history, "msg_queued", { type: "busy" })).toBe(false)
    expect(shouldAbortForUndo(history, "msg_z-user", { type: "busy" })).toBe(true)
    expect(shouldAbortForUndo(history, "msg_z-user", { type: "idle" })).toBe(false)
    expect(shouldAbortForUndo([messages[0]], "msg_z-user", { type: "busy" })).toBe(true)
  })

  test("manual compaction is the latest undoable input", () => {
    expect(undoableMessages(messages.slice(0, 2), parts).at(-1)?.id).toBe("msg_a-compact")
  })

  test("compaction and internal continuation are one undo step", () => {
    expect(undoableMessages(messages, parts).map((message) => message.id)).toEqual(["msg_z-user", "msg_a-compact"])
    expect(undoableMessages(messagesBeforeRevert(messages, "msg_a-compact"), parts).at(-1)?.id).toBe("msg_z-user")
  })

  test("real post-compaction input remains independently undoable", () => {
    expect(undoableMessages([...messages, user("msg_c-user", 4)], parts).at(-1)?.id).toBe("msg_c-user")
  })

  test("redo advances chronologically past internal continuation", () => {
    const history = [...messages, user("msg_0-next", 4)]
    const index = history.findIndex((message) => message.id === "msg_a-compact")
    expect(undoableMessages(history.slice(index + 1), parts)[0]?.id).toBe("msg_0-next")
    expect(undoableMessages(messages.slice(index + 1), parts)).toEqual([])
  })

  test("active history excludes a reverted summary and restores it on redo", () => {
    const summary: Message = {
      id: "msg_summary",
      role: "assistant",
      sessionID: "session",
      parentID: "msg_a-compact",
      time: { created: 3 },
      modelID: "test",
      providerID: "test",
      mode: "compaction",
      agent: "compaction",
      path: { cwd: "/tmp", root: "/tmp" },
      summary: true,
      cost: 0,
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const history = [...messages.slice(0, 2), summary]
    expect(messagesBeforeRevert(history, "msg_a-compact")).toEqual([messages[0]])
    expect(messagesBeforeRevert(history)).toEqual(history)
    expect(messagesBeforeRevert(history, "missing")).toEqual(history)
  })
})

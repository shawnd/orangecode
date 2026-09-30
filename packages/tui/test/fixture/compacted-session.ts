import type { AssistantMessage, Message, Part, Session, UserMessage } from "@opencode-ai/sdk/v2"
import { directory } from "./tui-sdk"

export function compactedSession() {
  const session: Session = {
    id: "parent",
    slug: "parent",
    projectID: "proj_test",
    directory,
    title: "Compaction regression",
    version: "test",
    time: { created: 1, updated: 5 },
  }
  const user = (id: string, created: number): UserMessage => ({
    id,
    role: "user",
    sessionID: session.id,
    time: { created },
    agent: "build",
    model: { providerID: "metadata-provider", modelID: "metadata-model" },
  })
  const assistant = (id: string, parentID: string, created: number, tokens: number): AssistantMessage => ({
    id,
    role: "assistant",
    sessionID: session.id,
    parentID,
    time: { created, completed: created },
    providerID: "metadata-provider",
    modelID: "metadata-model",
    mode: "build",
    agent: "build",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: tokens - 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  })
  const messages: Message[] = [
    user("msg_z-user", 1),
    assistant("msg_y-answer", "msg_z-user", 2, 90000),
    user("msg_a-compact", 3),
    { ...assistant("msg_b-summary", "msg_a-compact", 4, 12000), summary: true },
    user("msg_c-continue", 5),
  ]
  const parts: Record<string, Part[]> = {
    "msg_z-user": [
      { id: "part1", sessionID: session.id, messageID: "msg_z-user", type: "text", text: "Original question" },
    ],
    "msg_a-compact": [
      { id: "part2", sessionID: session.id, messageID: "msg_a-compact", type: "compaction", auto: false },
    ],
    "msg_c-continue": [
      {
        id: "part3",
        sessionID: session.id,
        messageID: "msg_c-continue",
        type: "text",
        text: "Internal continuation",
        synthetic: true,
      },
    ],
  }
  return { session, messages, parts }
}

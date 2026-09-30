import { expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { sessionTasks } from "../../src/util/session-background"

function task(id: string, parent: string, child: string, background = true): ToolPart {
  return {
    id,
    sessionID: parent,
    messageID: `${parent}-message`,
    callID: id,
    type: "tool",
    tool: "task",
    state: {
      status: "completed",
      input: {},
      title: child,
      output: "started",
      metadata: { sessionId: child, background },
      time: { start: 1, end: 2 },
    },
  }
}

test("tracks nested background agents outside the session filter and deduplicates resumed tasks", () => {
  const data = {
    session: [],
    part: {
      message: [
        task("one", "parent", "child"),
        task("retry", "parent", "child"),
        task("nested", "child", "grandchild"),
        task("other", "unrelated", "other-child"),
        task("foreground", "parent", "foreground-child", false),
        task("finished", "parent", "finished-child"),
      ],
    },
    session_status: {
      child: { type: "busy" as const },
      grandchild: { type: "retry" as const, attempt: 1, message: "retrying", next: 100 },
      "other-child": { type: "busy" as const },
      "foreground-child": { type: "busy" as const },
      "finished-child": { type: "idle" as const },
    },
  }
  expect(sessionTasks("parent", data).agents.map((item) => item.id)).toEqual(["child", "grandchild"])
  expect(sessionTasks(undefined, data)).toEqual({ agents: [], shells: [] })
})

test("shells include active descendant commands and exclude idle stale parts and other sessions", () => {
  const shell = (id: string, sessionID: string): ToolPart => ({
    id,
    sessionID,
    messageID: `${sessionID}-message`,
    callID: id,
    type: "tool",
    tool: "bash",
    state: { status: "running", input: { command: "bun test" }, time: { start: 1 }, metadata: {} },
  })
  const result = sessionTasks("parent", {
    session: [
      { id: "child", parentID: "parent" },
      { id: "idle-child", parentID: "parent" },
    ],
    part: {
      message: [
        shell("parent-shell", "parent"),
        shell("child-shell", "child"),
        shell("stale", "idle-child"),
        shell("other", "unrelated"),
      ],
    },
    session_status: {
      parent: { type: "busy" },
      child: { type: "busy" },
      "idle-child": { type: "idle" },
      unrelated: { type: "busy" },
    },
  })
  expect(result.shells.map((item) => item.id)).toEqual(["parent-shell", "child-shell"])
})

test("background shells stay active after the owning agent and tool call finish", () => {
  const shell = (id: string, shellStatus: string): ToolPart => ({
    id,
    sessionID: "parent",
    messageID: "message",
    callID: id,
    type: "tool",
    tool: "bash",
    state: {
      status: "completed",
      input: { command: "bun run build" },
      title: "Build",
      output: "Job started",
      time: { start: 1, end: 2 },
      metadata: { background: true, jobId: id, shellStatus },
    },
  })
  const result = sessionTasks("parent", {
    session: [],
    session_status: { parent: { type: "idle" } },
    part: {
      message: [
        shell("running", "running"),
        shell("done", "completed"),
        shell("stopped", "cancelled"),
        shell("failed", "error"),
      ],
    },
  })
  expect(result.shells.map((part) => part.id)).toEqual(["running"])
})

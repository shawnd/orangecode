import { expect, test } from "bun:test"
import type { SessionV2Info } from "@opencode-ai/sdk/v2/client"
import { summarizeUsage } from "./usage-stats"

test("aggregates all projects, the current project, and only the selected session", () => {
  const sessions = [
    {
      id: "current",
      projectID: "here",
      cost: 1.5,
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 4, write: 1 } },
    },
    {
      id: "sibling",
      projectID: "here",
      cost: 2,
      tokens: { input: 20, output: 8, reasoning: 0, cache: { read: 3, write: 2 } },
    },
    {
      id: "elsewhere",
      projectID: "there",
      cost: 3,
      tokens: { input: 30, output: 9, reasoning: 1, cache: { read: 6, write: 0 } },
    },
  ] as SessionV2Info[]

  const stats = summarizeUsage(sessions, "here", "current")

  expect(stats.all).toEqual({
    sessions: 3,
    cost: 6.5,
    tokens: { input: 60, output: 22, reasoning: 3, cache: { read: 13, write: 3 } },
  })
  expect(stats.project).toEqual({
    sessions: 2,
    cost: 3.5,
    tokens: { input: 30, output: 13, reasoning: 2, cache: { read: 7, write: 3 } },
  })
  expect(stats.session).toEqual({ sessions: 1, cost: 1.5, tokens: sessions[0].tokens })
  expect(summarizeUsage([], "here", "current").session.sessions).toBe(0)
})

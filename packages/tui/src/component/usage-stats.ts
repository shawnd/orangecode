import type { SessionV2Info } from "@opencode-ai/sdk/v2/client"

type Scope = "all" | "project" | "session"

export function summarizeUsage(sessions: readonly SessionV2Info[], projectID?: string, sessionID?: string) {
  const empty = () => ({
    sessions: 0,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const result = { all: empty(), project: empty(), session: empty() }

  for (const session of sessions) {
    const scopes: Scope[] = [
      "all",
      ...(projectID && session.projectID === projectID ? (["project"] as const) : []),
      ...(sessionID && session.id === sessionID ? (["session"] as const) : []),
    ]
    for (const scope of scopes) {
      const target = result[scope]
      target.sessions++
      target.cost += session.cost
      target.tokens.input += session.tokens.input
      target.tokens.output += session.tokens.output
      target.tokens.reasoning += session.tokens.reasoning
      target.tokens.cache.read += session.tokens.cache.read
      target.tokens.cache.write += session.tokens.cache.write
    }
  }
  return result
}

export * as SessionWorkState from "./work-state"

import { SessionWorkState } from "@opencode-ai/schema/session-work-state"
import type { BackgroundJob } from "../background-job"

export const Info = SessionWorkState.Info
export type Info = SessionWorkState.Info

/** Observational subtree activity; it never controls prompt admission or execution. */
export function summarize(input: {
  sessionID: string
  members: ReadonlySet<string>
  active: ReadonlySet<string>
  jobs: ReadonlyArray<BackgroundJob.Info>
  blocked: ReadonlyArray<string>
}): Info {
  const running = input.jobs.filter((job) => {
    if (job.status !== "running") return false
    const owner = job.metadata?.sessionId
    return typeof owner === "string" && input.members.has(owner)
  })
  const agents = new Set(
    [
      ...input.active,
      ...running.flatMap((job) =>
        job.type === "task" && typeof job.metadata?.sessionId === "string" ? [job.metadata.sessionId] : [],
      ),
    ].filter((id) => id !== input.sessionID && input.members.has(id)),
  )
  const shells = running.filter((job) => job.type === "shell").length
  const foreground = input.active.has(input.sessionID) ? "working" : "idle"
  return {
    type: input.blocked.some((id) => input.members.has(id))
      ? "blocked"
      : foreground === "working" || agents.size > 0 || shells > 0
        ? "working"
        : "idle",
    foreground,
    agents: agents.size,
    shells,
  }
}

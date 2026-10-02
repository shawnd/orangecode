import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "./agent"
import type { Session } from "../session/session"
import { Effect } from "effect"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent's full effective policy, preserving ordered allow exceptions.
 *    Subagent role denies are evaluated separately, so inherited grants cannot
 *    enable tools that the subagent's own role forbids.
 * 2. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't explicitly configure them.
 */
export function deriveSubagentSessionPermission(input: {
  parentAgentPermission: PermissionV1.Ruleset
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  return [
    ...input.parentAgentPermission,
    ...input.parentSessionPermission,
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}

// Keep each role's ordered rules together. Filtering only denies would erase
// allow exceptions, and flattening roles would let a descendant lift a deny.
export const subagentPermissionDenials = Effect.fn("Subagent.permissionDenials")(function* (input: {
  agent: Agent.Info
  session: Session.Info
  agents: Agent.Interface
  sessions: Session.Interface
}) {
  if (!input.session.parentID) return []
  const denials: PermissionV1.Ruleset[] = [input.agent.permission]
  let current = yield* input.sessions.get(input.session.parentID)
  while (current.parentID) {
    const agent = yield* input.agents.get(current.agent ?? (yield* input.agents.defaultAgent()))
    if (!agent) return yield* Effect.fail(new Error(`Unknown parent agent: ${current.agent}`))
    denials.push(agent.permission)
    current = yield* input.sessions.get(current.parentID)
  }
  return denials
}, Effect.orDie)

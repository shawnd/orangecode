import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { Permission } from "../../src/permission"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Agent.node))

function testAgent(input: {
  name: string
  mode: Agent.Info["mode"]
  permission: Parameters<typeof Permission.fromConfig>[0]
}) {
  return {
    name: input.name,
    mode: input.mode,
    permission: Permission.fromConfig(input.permission),
    options: {},
  } satisfies Agent.Info
}

// `deriveSubagentSessionPermission` is imported from production. The test
// exercises the actual helper that task.ts uses to build the subagent's
// session permission, so any regression in that helper trips this test.

it.instance("subagent inherits parent agent restrictions and ordered exceptions", () =>
  Effect.gen(function* () {
    const planAgent = yield* Agent.use.get("plan")
    const generalAgent = yield* Agent.use.get("general")

    expect(planAgent).toBeDefined()
    expect(generalAgent).toBeDefined()
    // Sanity: the plan agent itself blocks edit. (Note: `write` and
    // `apply_patch` route through the `edit` permission at the runtime
    // tool layer — see Permission.disabled / EDIT_TOOLS.)
    expect(Permission.evaluate("edit", "/some/file.ts", planAgent!.permission).action).toBe("deny")

    const parentSessionPermission: PermissionV1.Ruleset = []

    const subagentSessionPermission = deriveSubagentSessionPermission({
      parentAgentPermission: planAgent!.permission,
      parentSessionPermission,
      subagent: generalAgent!,
    })

    // Mirror the runtime evaluation in session/prompt.ts (~line 410, 639):
    //   ruleset: Permission.merge(agent.permission, session.permission ?? [])
    const effective = Permission.merge(generalAgent!.permission, subagentSessionPermission)

    expect(Permission.evaluate("edit", "/some/file.ts", effective).action).toBe("deny")
    expect(Permission.evaluate("edit", ".opencode/plans/proposal.md", effective).action).toBe("allow")
  }),
)

it.instance("subagent's own read-only restriction remains effective", () =>
  Effect.gen(function* () {
    const explore = yield* Agent.use.get("explore")
    expect(explore).toBeDefined()

    const parentSessionPermission: PermissionV1.Ruleset = []
    const subagentSessionPermission = deriveSubagentSessionPermission({
      parentAgentPermission: Permission.fromConfig({ "*": "allow" }),
      parentSessionPermission,
      subagent: explore!,
    })
    const effective = Permission.merge(explore!.permission, subagentSessionPermission)

    expect(Permission.denied("edit", "/x.ts", [explore!.permission])).toBe(explore!.permission)
    expect(Permission.disabled(["edit", "write", "apply_patch"], effective, [explore!.permission])).toEqual(
      new Set(["edit", "write", "apply_patch"]),
    )
  }),
)

it.instance(
  "custom subagent cannot enable edits denied to its parent agent",
  () =>
    Effect.gen(function* () {
      const planAgent = yield* Agent.use.get("plan")
      const my = yield* Agent.use.get("my_subagent")
      expect(planAgent).toBeDefined()
      expect(my).toBeDefined()

      const parentSessionPermission: PermissionV1.Ruleset = []
      const subagentSessionPermission = deriveSubagentSessionPermission({
        parentAgentPermission: planAgent!.permission,
        parentSessionPermission,
        subagent: my!,
      })
      const effective = Permission.merge(my!.permission, subagentSessionPermission)

      expect(Permission.evaluate("edit", "/some/file.ts", planAgent!.permission).action).toBe("deny")
      expect(Permission.evaluate("edit", "/some/file.ts", effective).action).toBe("deny")
    }),
  {
    config: {
      agent: {
        my_subagent: {
          description: "A user-defined subagent",
          mode: "subagent",
          permission: {
            edit: "allow",
          },
        },
      },
    },
  },
)

it.effect("subagent self permissions are preserved", () =>
  Effect.sync(() => {
    const executor = testAgent({
      name: "executor",
      mode: "subagent",
      permission: {
        "*": "deny",
        read: "allow",
        bash: "allow",
        task: {
          "*": "deny",
          worker: "allow",
        },
        edit: "allow",
      },
    })

    const effective = Permission.merge(
      executor.permission,
      deriveSubagentSessionPermission({
        parentAgentPermission: [],
        parentSessionPermission: [],
        subagent: executor,
      }),
    )

    expect(Permission.evaluate("read", "README.md", effective).action).toBe("allow")
    expect(Permission.evaluate("bash", "git status", effective).action).toBe("allow")
    expect(Permission.evaluate("task", "worker", effective).action).toBe("allow")
    expect(Permission.evaluate("task", "other", effective).action).toBe("deny")
    expect(Permission.disabled(["edit", "write", "apply_patch"], effective)).toEqual(new Set())
  }),
)

it.effect("subagent inherits parent session deny rules as hard runtime ceilings", () =>
  Effect.sync(() => {
    const executor = testAgent({
      name: "executor",
      mode: "subagent",
      permission: {
        bash: "allow",
      },
    })
    const effective = Permission.merge(
      executor.permission,
      deriveSubagentSessionPermission({
        parentAgentPermission: [],
        parentSessionPermission: Permission.fromConfig({ bash: "deny" }),
        subagent: executor,
      }),
    )

    expect(Permission.evaluate("bash", "git status", effective).action).toBe("deny")
  }),
)

it.effect("inherits parent session asks, grants, and deny exceptions without filtering", () =>
  Effect.sync(() => {
    const executor = testAgent({ name: "executor", mode: "subagent", permission: { "*": "allow", bash: "ask" } })
    const parent = Permission.fromConfig({
      edit: "ask",
      bash: { "*": "deny", "git *": "allow" },
      read: "allow",
      external_directory: { "*": "ask", "/shared/*": "allow" },
    })
    const inherited = deriveSubagentSessionPermission({
      parentAgentPermission: Permission.fromConfig({ "*": "allow", read: "ask" }),
      parentSessionPermission: parent,
      subagent: executor,
    })
    const effective = Permission.merge(executor.permission, inherited)

    expect(inherited.slice(2, 2 + parent.length)).toEqual(parent)
    expect(Permission.evaluate("edit", "file.ts", effective).action).toBe("ask")
    expect(Permission.evaluate("read", "file.ts", effective).action).toBe("allow")
    expect(Permission.evaluate("bash", "git status", effective).action).toBe("allow")
    expect(Permission.evaluate("bash", "rm file.ts", effective).action).toBe("deny")
    expect(Permission.evaluate("external_directory", "/shared/code/*", effective).action).toBe("allow")
  }),
)

it.effect("role denial ceilings preserve allow exceptions and cannot be lifted by another role", () =>
  Effect.sync(() => {
    const reviewer = Permission.fromConfig({ "*": "deny", read: "allow", bash: { "*": "deny", "git *": "allow" } })
    const worker = Permission.fromConfig({ "*": "allow" })
    const denials = [worker, reviewer]

    expect(Permission.denied("read", "README.md", denials)).toBeUndefined()
    expect(Permission.denied("bash", "git status", denials)).toBeUndefined()
    expect(Permission.denied("bash", "rm file.ts", denials)).toBe(reviewer)
    expect(Permission.denied("edit", "file.ts", denials)).toBe(reviewer)
    expect(Permission.disabled(["read", "bash", "edit"], worker, denials)).toEqual(new Set(["edit"]))
  }),
)

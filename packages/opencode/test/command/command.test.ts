import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Skill } from "@/skill"
import { TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(Command.node, [
      [Config.node, TestConfig.layer()],
      [MCP.node, Layer.mock(MCP.Service, { prompts: () => Effect.succeed({}) })],
      [Skill.node, Layer.mock(Skill.Service, { all: () => Effect.succeed([]) })],
    ]),
    testInstanceStoreLayer,
  ),
)

describe("built-in verify command", () => {
  it.instance("is listed and resolves to a project-specific verification prompt", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const test = yield* TestInstance
      const listed = (yield* command.list()).find((item) => item.name === Command.Default.VERIFY)
      const resolved = yield* command.get("verify")

      expect(resolved).toBe(listed)
      expect(resolved?.source).toBe("command")
      expect(resolved?.description).toContain("verify")
      expect(resolved?.hints).toEqual(["$ARGUMENTS"])
      expect(resolved?.template).toContain(test.directory)
      expect(resolved?.template).toContain("build")
      expect(resolved?.template).toContain("smoke")
      expect(resolved?.template).toContain("exact commands")
      expect(resolved?.template).toContain("visual verification was not performed")
    }),
  )
})

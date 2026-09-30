import path from "node:path"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { MCP } from "@/mcp"
import { Config } from "@/config/config"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { MessageID, SessionID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([ToolRegistry.node, MCP.node, Config.node, FSUtil.node])))
const fixture = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")

function context(permissions: string[] = []): Tool.Context {
  return {
    sessionID: SessionID.create(),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.sync(() => {
        permissions.push(request.permission)
      }),
  }
}

describe("MCP management tools", () => {
  it.instance("adds, lists, disconnects, reconnects, and removes a real local server", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const mcp = yield* MCP.Service
      const permissions: string[] = []
      const ctx = context(permissions)
      const tools = yield* registry.all()
      const execute = (id: string, input: unknown) => {
        const tool = tools.find((tool) => tool.id === id)
        if (!tool) throw new Error(`Missing tool: ${id}`)
        return tool.execute(input, ctx)
      }
      yield* execute("mcp_add", {
        name: "managed",
        config: { type: "local", command: [process.execPath, fixture] },
        scope: "runtime",
      })
      expect((yield* mcp.status()).managed.status).toBe("connected")
      const listed = yield* execute("mcp_list", {})
      expect(JSON.parse(listed.output)).toContainEqual(
        expect.objectContaining({ name: "managed", tools: ["managed_current_directory"] }),
      )
      yield* execute("mcp_disconnect", { name: "managed" })
      expect(yield* mcp.tools()).toEqual({})
      yield* execute("mcp_connect", { name: "managed" })
      expect(Object.keys(yield* mcp.tools())).toContain("managed_current_directory")
      const client = (yield* mcp.clients()).managed
      yield* execute("mcp_reconnect", { name: "managed" })
      expect((yield* mcp.clients()).managed).not.toBe(client)
      yield* execute("mcp_remove", { name: "managed", scope: "runtime" })
      expect(yield* mcp.status()).toEqual({})
      expect(yield* mcp.clients()).toEqual({})
      expect(permissions).toEqual(["mcp_add", "mcp_disconnect", "mcp_connect", "mcp_reconnect", "mcp_remove"])
    }),
  )

  it.instance("persists replacements while preserving JSONC comments and unrelated fields", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* FSUtil.Service
      const mcp = yield* MCP.Service
      const config = yield* Config.Service
      const file = path.join(test.directory, "opencode.jsonc")
      yield* fs.writeFileString(
        file,
        '{\n // keep this comment\n "username": "keep",\n "mcp": {"managed": {"type":"remote","url":"https://example.com/mcp","headers":{"Authorization":"old-secret"},"enabled":false}}\n}',
      )
      const result = yield* mcp.configure(
        "managed",
        { type: "local", command: [process.execPath, fixture], enabled: false },
        "project",
      )
      expect(result.file).toBe(file)
      expect(result.status.status).toBe("disabled")
      const text = yield* fs.readFileString(file)
      expect(text).toContain("// keep this comment")
      expect(text).not.toContain("old-secret")
      expect(text).not.toContain('"url"')
      expect((yield* config.get()).username).toBe("keep")
      expect((yield* config.get()).mcp?.managed).toEqual({
        type: "local",
        command: [process.execPath, fixture],
        enabled: false,
      })
      yield* mcp.remove("managed", "project")
      expect((yield* config.get()).mcp?.managed).toBeUndefined()
      expect(yield* mcp.status()).toEqual({})
      expect(yield* fs.readFileString(file)).toContain("// keep this comment")
    }),
  )

  it.instance("omits credential values from inspection and respects disabled runtime adds", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const registry = yield* ToolRegistry.Service
      yield* mcp.configure(
        "private",
        {
          type: "remote",
          url: "https://example.com/mcp",
          headers: { Authorization: "secret-header" },
          oauth: { clientSecret: "secret-client" },
          enabled: false,
        },
        "runtime",
      )
      expect((yield* mcp.status()).private.status).toBe("disabled")
      const list = (yield* registry.all()).find((tool) => tool.id === "mcp_list")
      if (!list) throw new Error("Missing mcp_list")
      const result = yield* list.execute({}, context())
      expect(result.output).toContain("Authorization")
      expect(result.output).not.toContain("secret-header")
      expect(result.output).not.toContain("secret-client")
    }),
  )

  it.instance("asks permission before starting a server", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const registry = yield* ToolRegistry.Service
      const add = (yield* registry.all()).find((tool) => tool.id === "mcp_add")
      if (!add) throw new Error("Missing mcp_add")
      const ctx = { ...context(), ask: () => Effect.die(new Error("Denied")) }
      const result = yield* add
        .execute(
          { name: "denied", config: { type: "local", command: [process.execPath, fixture] }, scope: "runtime" },
          ctx,
        )
        .pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      expect(yield* mcp.status()).toEqual({})
    }),
  )

  it.instance("keeps simultaneous persisted additions and rejects invalid config before writing", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const config = yield* Config.Service
      const test = yield* TestInstance
      const fs = yield* FSUtil.Service
      const invalid = yield* mcp
        .configure("invalid", { type: "local", command: [], enabled: false }, "project")
        .pipe(Effect.exit)
      expect(invalid._tag).toBe("Failure")
      expect(yield* fs.exists(path.join(test.directory, "opencode.json"))).toBe(false)
      yield* Effect.all(
        ["first", "second"].map((name) =>
          mcp.configure(name, { type: "local", command: ["unused"], enabled: false }, "project"),
        ),
        { concurrency: "unbounded" },
      )
      expect(Object.keys((yield* config.get()).mcp ?? {}).sort()).toEqual(["first", "second"])
      expect(Object.keys(yield* mcp.configured()).sort()).toEqual(["first", "second"])
    }),
  )
})

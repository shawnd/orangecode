import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LSP } from "@/lsp/lsp"
import { Permission } from "../../src/permission"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { LspTool } from "../../src/tool/lsp"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const workspaceSymbolQueries: string[] = []

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(true),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed([]),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: (query) =>
      Effect.sync(() => {
        workspaceSymbolQueries.push(query)
        return []
      }),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const it = testEffect(
  LayerNode.compile(LayerNode.group([Agent.node, FSUtil.node, CrossSpawnSpawner.node, Truncate.node, LSP.node]), [
    [LSP.node, lsp],
  ]),
)

const realIt = testEffect(
  LayerNode.compile(LayerNode.group([Agent.node, FSUtil.node, CrossSpawnSpawner.node, Truncate.node, LSP.node])),
)

const init = Effect.fn("LspToolTest.init")(function* () {
  const info = yield* LspTool
  return yield* info.init()
})

const run = Effect.fn("LspToolTest.run")(function* (
  args: Tool.InferParameters<typeof LspTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const put = Effect.fn("LspToolTest.put")(function* (file: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, "export const x = 1\n")
})

const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    },
  }
}

describe("tool.lsp", () => {
  realIt.instance(
    "navigation does not wait for a server that never publishes diagnostics",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "silent.repro")
        yield* put(file)
        const started = performance.now()
        const result = yield* run({ operation: "hover", filePath: file, line: 1, character: 1 })
        expect(result.title).toBe("hover silent.repro:1:1")
        expect(performance.now() - started).toBeLessThan(3000)
      }),
    {
      git: true,
      config: {
        lsp: {
          silent: {
            command: [process.execPath, path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")],
            extensions: [".repro"],
          },
        },
      },
    },
  )

  describe("permission metadata", () => {
    it.instance(
      "keeps cursor details for position-based operations",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "test.ts")
          yield* put(file)

          const { items, next } = asks()
          const result = yield* run({ operation: "goToDefinition", filePath: file, line: 3, character: 7 }, next)
          const req = items.find((item) => item.permission === "lsp")

          expect(req).toBeDefined()
          expect(req!.metadata).toEqual({
            operation: "goToDefinition",
            filePath: file,
            line: 3,
            character: 7,
          })
          expect(result.title).toBe("goToDefinition test.ts:3:7")
        }),
      { git: true },
    )

    it.instance(
      "omits cursor details for documentSymbol",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "test.ts")
          yield* put(file)

          const { items, next } = asks()
          const result = yield* run({ operation: "documentSymbol", filePath: file, line: 3, character: 7 }, next)
          const req = items.find((item) => item.permission === "lsp")

          expect(req).toBeDefined()
          expect(req!.metadata).toEqual({
            operation: "documentSymbol",
            filePath: file,
          })
          expect(result.title).toBe("documentSymbol test.ts")
        }),
      { git: true },
    )

    it.instance(
      "omits file and cursor details for workspaceSymbol",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          workspaceSymbolQueries.length = 0
          const file = path.join(dir, "test.ts")
          yield* put(file)

          const { items, next } = asks()
          const result = yield* run({ operation: "workspaceSymbol", filePath: file, line: 3, character: 7 }, next)
          const req = items.find((item) => item.permission === "lsp")

          expect(req).toBeDefined()
          expect(req!.metadata).toEqual({
            operation: "workspaceSymbol",
          })
          expect(result.title).toBe("workspaceSymbol")
        }),
      { git: true },
    )

    it.instance(
      "passes workspaceSymbol query to LSP",
      () =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          workspaceSymbolQueries.length = 0
          const file = path.join(dir, "test.ts")
          yield* put(file)

          yield* run({ operation: "workspaceSymbol", filePath: file, line: 3, character: 7, query: "TestSymbol" })
          yield* run({ operation: "workspaceSymbol", filePath: file, line: 3, character: 7 })

          expect(workspaceSymbolQueries).toEqual(["TestSymbol", ""])
        }),
      { git: true },
    )
  })
})

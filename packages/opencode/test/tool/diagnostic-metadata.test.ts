import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LSP } from "@/lsp/lsp"
import { Format } from "@/format"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { WriteTool } from "@/tool/write"
import { EditTool } from "@/tool/edit"
import { ApplyPatchTool } from "@/tool/apply_patch"
import { MessageID, SessionID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([
  LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node,
])))
const ctx = {
  sessionID: SessionID.make("ses_diagnostics"), messageID: MessageID.make("msg_diagnostics"),
  callID: "diagnostics", agent: "build", abort: AbortSignal.any([]), messages: [],
  metadata: () => Effect.void, ask: () => Effect.void,
}
const options = {
  config: { formatter: false as const, lsp: Object.fromEntries([0, 1].map((server) => [`metadata-${server}`, {
    command: [process.execPath, path.join(import.meta.dir, "../fixture/lsp/diagnostic-metadata-server.ts"), "12", String(server)],
    extensions: [".diag"],
  }])) },
}

it.instance("scoped diagnostics normalize/deduplicate requested paths and preserve per-client push/pull deduplication", () => Effect.gen(function* () {
  const instance = yield* TestInstance
  const lsp = yield* LSP.Service
  const file = path.join(instance.directory, "affected.diag")
  yield* Effect.promise(() => Bun.write(file, "old\n"))
  yield* lsp.touchFile(file, "document")
  const all = yield* lsp.diagnostics()
  const selected = yield* lsp.diagnostics({ files: [file, "affected.diag", `${instance.directory}/./affected.diag`] })
  expect(Object.keys(selected)).toEqual([FSUtil.normalizePath(file)])
  expect(selected[FSUtil.normalizePath(file)]).toEqual(all[FSUtil.normalizePath(file)])
  expect(selected[FSUtil.normalizePath(file)]).toHaveLength(4)
  expect(yield* lsp.diagnostics({ files: [] })).toEqual({})
  expect(yield* lsp.diagnostics({ files: ["missing.diag"] })).toEqual({})
  const bounded = yield* lsp.diagnostics({ files: [file], otherFiles: 5 })
  const context = new Set(Object.keys(all).filter((name) => name !== FSUtil.normalizePath(file)).slice(0, 5))
  expect(Object.keys(bounded)).toEqual(Object.keys(all).filter((name) => name === FSUtil.normalizePath(file) || context.has(name)))
  // Warnings from server 0 must not hide the same file's errors on server 1.
  expect(bounded[FSUtil.normalizePath(path.join(instance.directory, "unrelated-00000.diag"))]).toHaveLength(48)
}), options)

it.instance("write preserves the exact bounded cross-file report while persisting only the written file", () => Effect.gen(function* () {
  const instance = yield* TestInstance
  const lsp = yield* LSP.Service
  const info = yield* WriteTool
  const tool = yield* info.init()
  const file = path.join(instance.directory, "affected.diag")
  const result = yield* tool.execute({ filePath: file, content: "new\n" }, ctx)
  const all = yield* lsp.diagnostics()
  const context = new Set(Object.entries(all)
    .filter(([name, issues]) => name !== FSUtil.normalizePath(file) && issues.some((item) => item.severity === 1))
    .slice(0, 5).map(([name]) => name))
  const reports = Object.entries(all).filter(([name]) => name === FSUtil.normalizePath(file) || context.has(name))
  const expected = "Wrote file successfully." + reports.map(([name, issues]) =>
    `\n\nLSP errors detected in ${name === FSUtil.normalizePath(file) ? "this file, please fix" : "other files"}:\n${LSP.Diagnostic.report(name, issues)}`,
  ).join("")
  expect(result.output).toBe(expected)
  expect(result.output).toContain("... and 28 more")
  expect(result.output).not.toContain("unrelated-00004")
  expect(Object.keys(result.metadata.diagnostics)).toEqual([FSUtil.normalizePath(file)])
  expect(result.metadata.diagnostics[FSUtil.normalizePath(file)]).toEqual(all[FSUtil.normalizePath(file)])
}), options)

it.instance("edit scopes metadata, patch selects multiple targets including moves and excludes deleted files", () => Effect.gen(function* () {
  const instance = yield* TestInstance
  const lsp = yield* LSP.Service
  const file = path.join(instance.directory, "affected.diag")
  const second = path.join(instance.directory, "second.diag")
  const deleted = path.join(instance.directory, "deleted.diag")
  const moved = path.join(instance.directory, "moved.diag")
  for (const target of [file, second, deleted]) yield* Effect.promise(() => Bun.write(target, "old\n"))
  yield* lsp.touchFile(deleted, "document")
  const editInfo = yield* EditTool
  const edit = yield* editInfo.init()
  const edited = yield* edit.execute({ filePath: file, oldString: "old", newString: "new" }, ctx)
  expect(Object.keys(edited.metadata.diagnostics)).toEqual([FSUtil.normalizePath(file)])
  expect(edited.output).toContain("affected error")
  const patchInfo = yield* ApplyPatchTool
  const patch = yield* patchInfo.init()
  const patched = yield* patch.execute({ patchText: `*** Begin Patch\n*** Update File: ${file}\n@@\n-new\n+next\n*** Update File: ${second}\n*** Move to: ${moved}\n@@\n-old\n+next\n*** Delete File: ${deleted}\n*** End Patch` }, ctx)
  expect(Object.keys(patched.metadata.diagnostics).sort()).toEqual([file, moved].map(FSUtil.normalizePath).sort())
  expect(patched.output).toContain(`<diagnostics file="${moved}">`)
  expect(patched.metadata.diagnostics[FSUtil.normalizePath(moved)]).toHaveLength(4)
}), options)

it.instance("no diagnostics produces empty metadata and no error reports", () => Effect.gen(function* () {
  const instance = yield* TestInstance
  const info = yield* WriteTool
  const tool = yield* info.init()
  const result = yield* tool.execute({ filePath: path.join(instance.directory, "empty.txt"), content: "" }, ctx)
  expect(result.metadata.diagnostics).toEqual({})
  expect(result.output).toBe("Wrote file successfully.")
}))

it.instance("empty document reports stay empty even when unrelated errors exist", () => Effect.gen(function* () {
  const instance = yield* TestInstance
  const lsp = yield* LSP.Service
  const file = path.join(instance.directory, "empty.diag")
  yield* Effect.promise(() => Bun.write(file, ""))
  yield* lsp.touchFile(file, "document")
  expect(yield* lsp.diagnostics({ files: [file] })).toEqual({ [FSUtil.normalizePath(file)]: [] })
  const info = yield* WriteTool
  const tool = yield* info.init()
  const result = yield* tool.execute({ filePath: file, content: "" }, ctx)
  expect(result.metadata.diagnostics).toEqual({ [FSUtil.normalizePath(file)]: [] })
  expect(result.output).not.toContain("LSP errors detected in this file")
  expect(result.output.match(/LSP errors detected in other files/g)).toHaveLength(5)
}), options)

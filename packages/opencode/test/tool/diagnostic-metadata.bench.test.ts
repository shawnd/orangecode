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
  sessionID: SessionID.make("ses_diagnostic_bench"),
  messageID: MessageID.make("msg_diagnostic_bench"),
  callID: "diagnostic-bench",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}
const enabled = !!process.env.DIAGNOSTIC_BENCH_OUTPUT
const samples: unknown[] = []

for (const population of [0, 100, 1000, 10000]) {
  const run = enabled ? it.instance : it.instance.skip
  run(`diagnostic metadata benchmark: ${population} unrelated files`, () => Effect.gen(function* () {
    const instance = yield* TestInstance
    const lsp = yield* LSP.Service
    const file = path.join(instance.directory, "affected.diag")
    const second = path.join(instance.directory, "second.diag")
    yield* Effect.promise(() => Bun.write(file, "old\n"))
    yield* Effect.promise(() => Bun.write(second, "old\n"))
    yield* lsp.touchFile(file, "document")
    const measurements = { calls: 0, ms: 0, files: 0, diagnostics: 0 }
    const measured = {
      ...lsp,
      diagnostics: (...args: Parameters<typeof lsp.diagnostics>) => Effect.gen(function* () {
        const start = performance.now()
        const result = yield* lsp.diagnostics(...args)
        measurements.ms += performance.now() - start
        measurements.calls++
        measurements.files += Object.keys(result).length
        measurements.diagnostics += Object.values(result).reduce((n, items) => n + items.length, 0)
        return result
      }),
    }
    const write = yield* WriteTool.pipe(Effect.provideService(LSP.Service, measured))
    const edit = yield* EditTool.pipe(Effect.provideService(LSP.Service, measured))
    const patch = yield* ApplyPatchTool.pipe(Effect.provideService(LSP.Service, measured))
    const tools = [
      { name: "write", execute: (yield* write.init()).execute({ filePath: file, content: "new\n" }, ctx) },
      { name: "edit", execute: (yield* edit.init()).execute({ filePath: file, oldString: "old", newString: "new" }, ctx) },
      { name: "apply_patch", execute: (yield* patch.init()).execute({ patchText: `*** Begin Patch\n*** Update File: ${file}\n@@\n-old\n+new\n*** Update File: ${second}\n@@\n-old\n+new\n*** End Patch` }, ctx) },
    ]
    for (const tool of tools) {
      for (let trial = -2; trial < 7; trial++) {
        yield* Effect.promise(() => Bun.write(file, "old\n"))
        yield* Effect.promise(() => Bun.write(second, "old\n"))
        Object.assign(measurements, { calls: 0, ms: 0, files: 0, diagnostics: 0 })
        const start = performance.now()
        const result = yield* tool.execute
        const toolMs = performance.now() - start
        expect(result.output).toContain("affected error")
        const normalized = JSON.parse(JSON.stringify(result).replaceAll(instance.directory, "/fixture"))
        const metadata = normalized.metadata
        const part = { id: "prt_bench", sessionID: ctx.sessionID, messageID: ctx.messageID, type: "tool", callID: ctx.callID, tool: tool.name,
          state: { status: "completed", input: {}, output: normalized.output, title: normalized.title, metadata, time: { start: 0, end: 1 } } }
        const serializeStart = performance.now()
        const partBytes = Buffer.byteLength(JSON.stringify(structuredClone(part)))
        const cloneSerializeMs = performance.now() - serializeStart
        if (trial < 0) continue
        samples.push({ population, tool: tool.name, trial, toolMs, retrieval: { ...measurements },
          metadataFiles: Object.keys(metadata.diagnostics).length,
          metadataDiagnostics: Object.values(metadata.diagnostics as Record<string, unknown[]>).reduce((n, items) => n + items.length, 0),
          metadataBytes: Buffer.byteLength(JSON.stringify(metadata)), partBytes, cloneSerializeMs,
          output: normalized.output,
        })
      }
    }
    yield* Effect.promise(() => Bun.write(process.env.DIAGNOSTIC_BENCH_OUTPUT ?? "", JSON.stringify({
      baseline: "e6f0f15a59125fb1775dd081da144ec16c4622aa", warmups: 2, trials: 7, servers: 2, samples,
    }, null, 2)))
  }), {
    config: { formatter: false, lsp: Object.fromEntries([0, 1].map((server) => [`metadata-${server}`, {
      command: [process.execPath, path.join(import.meta.dir, "../fixture/lsp/diagnostic-metadata-server.ts"), String(population), String(server)],
      extensions: [".diag"],
    }])) },
  }, 120000)
}

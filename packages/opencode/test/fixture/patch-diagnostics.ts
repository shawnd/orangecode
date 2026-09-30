import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { ApplyPatchTool } from "@/tool/apply_patch"
import { Truncate } from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"

export const layer = LayerNode.compile(
  LayerNode.group([LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node]),
)

export const config = (mode: string) => ({
  formatter: false as const,
  lsp: {
    "patch-probe": {
      command: [process.execPath, path.join(import.meta.dir, "lsp/patch-diagnostics-server.js"), mode],
      extensions: [".patchprobe"],
    },
  },
})

export const execute = Effect.fn("PatchDiagnosticsFixture.execute")(function* (patchText: string) {
  const info = yield* ApplyPatchTool
  const tool = yield* info.init()
  return yield* tool.execute(
    { patchText },
    {
      sessionID: SessionID.make("ses_patch_probe"),
      messageID: MessageID.make("msg_patch_probe"),
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    },
  )
})

export const patch = (count: number) =>
  [
    "*** Begin Patch",
    ...Array.from({ length: count }, (_, i) => `*** Add File: file-${i}.patchprobe\n+value ${i}`),
    "*** End Patch",
  ].join("\n")

// Decorate, never replace, the real service to observe tool-level wait lifetimes.
export const observe = (lsp: LSP.Interface) => {
  const stats = { touches: 0, waits: 0, active: 0, peak: 0, completed: 0, interrupted: 0 }
  return {
    stats,
    service: {
      ...lsp,
      touchFile: (file: string, mode?: "document" | "full") =>
        Effect.gen(function* () {
          stats.touches++
          if (mode) stats.waits++
          stats.active++
          stats.peak = Math.max(stats.peak, stats.active)
          yield* lsp.touchFile(file, mode).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                stats.interrupted++
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                stats.active--
              }),
            ),
          )
          stats.completed++
        }),
    },
  }
}

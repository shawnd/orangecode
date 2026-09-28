import { Effect, Schema } from "effect"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({})

export const CompactTool = Tool.define(
  "compact",
  Effect.succeed({
    description:
      "Compact the current session's context after this model turn finishes, then continue working with the summary. Use when the conversation is getting too large or the user asks to compact. This schedules compaction; it does not run inside the active tool call.",
    parameters: Parameters,
    execute: () =>
      Effect.succeed({
        title: "Compact context",
        output: "Compaction requested. The session will compact after this turn's tools finish, then continue.",
        metadata: {},
      }),
  }),
)

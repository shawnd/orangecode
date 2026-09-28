import { Effect, Schema } from "effect"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageV2 } from "@/session/message-v2"
import { usable } from "@/session/overflow"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({})

export const ContextUsageTool = Tool.define(
  "context_usage",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const flags = yield* RuntimeFlags.Service

    return {
      description:
        "Show the current session's model, context window, last completed model turn's token usage and approximate context percentage. Use to decide whether to compact. The active turn's final usage is not available until it completes; this is a snapshot, not an exact count of the pending prompt.",
      parameters: Parameters,
      execute: (_: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const history = MessageV2.latest(ctx.messages)
          const selected = history.user?.model
          if (!selected) return yield* Effect.fail(new Error("No model selected for this session"))
          const model = yield* provider.getModel(selected.providerID, selected.modelID)
          const last = history.finished
          const measured =
            last?.providerID === model.providerID && last.modelID === model.id && last.tokens.output > 0
              ? last
              : undefined
          const window = model.limit.context
          const cfg = yield* config.get()
          const threshold =
            cfg.compaction?.auto === false ? undefined : usable({ cfg, model, outputTokenMax: flags.outputTokenMax })
          const tokens = measured
            ? measured.tokens.total ||
              measured.tokens.input + measured.tokens.output + measured.tokens.cache.read + measured.tokens.cache.write
            : undefined
          const percent = tokens !== undefined && window > 0 ? Math.round((tokens / window) * 1000) / 10 : undefined
          return {
            title: "Context usage",
            output: [
              `Model: ${model.providerID}/${model.id}`,
              `Context window: ${window > 0 ? window.toLocaleString() : "unknown"} tokens`,
              cfg.compaction?.auto === false
                ? "Automatic compaction: disabled"
                : `Automatic compaction threshold: ${threshold && threshold > 0 ? threshold.toLocaleString() : "unknown"} tokens`,
              ...(tokens === undefined
                ? ["Usage: no completed turn measured on this model yet"]
                : [
                    `Last completed turn: ${tokens.toLocaleString()} tokens (${percent}% of context window)`,
                    [
                      `Input: ${measured?.tokens.input.toLocaleString()}`,
                      `Cache read: ${measured?.tokens.cache.read.toLocaleString()}`,
                      `Cache write: ${measured?.tokens.cache.write.toLocaleString()}`,
                      `Output: ${measured?.tokens.output.toLocaleString()}`,
                      `Reasoning: ${measured?.tokens.reasoning.toLocaleString()}`,
                    ].join(" · "),
                    `Remaining at last measurement: ${Math.max(0, window - tokens).toLocaleString()} tokens`,
                  ]),
              "Current in-flight turn and any new input are not included in this measurement.",
            ].join("\n"),
            metadata: { model: `${model.providerID}/${model.id}`, tokens, window, threshold, percent },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

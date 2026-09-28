export * as ConfigCompaction from "./compaction"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

export class Keep extends Schema.Class<Keep>("ConfigV2.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Compaction")({
  auto: Schema.Boolean.pipe(Schema.optional),
  prune: Schema.Boolean.pipe(Schema.optional),
  keep: Keep.pipe(Schema.optional),
  buffer: NonNegativeInt.pipe(Schema.optional),
  threshold_percent: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100))
    .pipe(Schema.optional)
    .annotate({
      description:
        "Compact at this percentage of the model context window, subject to the safe output and input limits.",
    }),
}) {}

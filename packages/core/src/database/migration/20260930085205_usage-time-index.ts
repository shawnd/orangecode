import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260930085205_usage-time-index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`part_usage_time_created_idx\` ON \`part\` (\`time_created\`,\`session_id\`) WHERE json_extract("part"."data", '$.type') = 'step-finish';`,
      )
    })
  },
} satisfies DatabaseMigration.Migration

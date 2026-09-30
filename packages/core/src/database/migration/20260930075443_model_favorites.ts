import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260930075443_model_favorites",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`model_favorite\` (
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`model_favorite_pk\` PRIMARY KEY(\`provider_id\`, \`model_id\`)
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration

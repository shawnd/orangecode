import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260930085547_query-index-coverage",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE INDEX \`workspace_project_idx\` ON \`workspace\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`event_seq_idx\` ON \`event\` (\`seq\`);`)
      yield* tx.run(
        `CREATE INDEX \`part_text_session_idx\` ON \`part\` (\`session_id\`) WHERE json_extract("part"."data", '$.type') = 'text';`,
      )
      yield* tx.run(`CREATE INDEX \`session_updated_id_idx\` ON \`session\` (\`time_updated\`,\`id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_project_updated_id_idx\` ON \`session\` (\`project_id\`,\`time_updated\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_created_id_idx\` ON \`session\` (\`time_created\`,\`id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_project_created_id_idx\` ON \`session\` (\`project_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_directory_created_id_idx\` ON \`session\` (\`directory\`,\`time_created\`,\`id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration

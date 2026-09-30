import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const ModelFavoriteTable = sqliteTable(
  "model_favorite",
  {
    provider_id: text().notNull(),
    model_id: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.provider_id, table.model_id] })],
)

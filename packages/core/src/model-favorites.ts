export * as ModelFavorites from "./model-favorites"

import path from "path"
import { and, asc, desc, eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { DataMigrationTable } from "./data-migration.sql"
import { makeGlobalNode } from "./effect/app-node"
import { LayerNode } from "./effect/layer-node"
import { makeRuntime } from "./effect/runtime"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { ModelFavoriteTable } from "./model-favorites/sql"

export const Model = Schema.Struct({ providerID: Schema.String, modelID: Schema.String })
export type Model = typeof Model.Type

const Saved = Schema.Struct({ favorite: Schema.optional(Schema.Array(Model)) })
const MIGRATION = "global-model-favorites-json"

export interface Interface {
  readonly list: () => Effect.Effect<Model[]>
  readonly set: (model: Model, favorite: boolean) => Effect.Effect<void>
}

export interface Store {
  readonly list: () => Promise<Model[]>
  readonly set: (model: Model, favorite: boolean) => Promise<void>
  readonly dispose: () => Promise<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelFavorites") {}

export const layer = (directory: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const fs = yield* FSUtil.Service
      const migrated = yield* database.db
        .select()
        .from(DataMigrationTable)
        .where(eq(DataMigrationTable.name, MIGRATION))
        .get()
      if (!migrated) {
        const protectedFile = path.join(directory, "model-favorites.json")
        const legacyFile = path.join(directory, "model.json")
        const file = (yield* fs.exists(protectedFile)) ? protectedFile : legacyFile
        const saved = (yield* fs.exists(file))
          ? yield* Schema.decodeUnknownEffect(Saved)(yield* fs.readJson(file))
          : { favorite: [] }
        const now = yield* Clock.currentTimeMillis
        yield* database.db.transaction(
          (tx) =>
            Effect.gen(function* () {
              const claimed = yield* tx
                .insert(DataMigrationTable)
                .values({ name: MIGRATION, time_completed: now })
                .onConflictDoNothing()
                .returning()
                .get()
              if (!claimed || !saved.favorite?.length) return
              yield* tx
                .insert(ModelFavoriteTable)
                .values(
                  saved.favorite.map((model, index) => ({
                    provider_id: model.providerID,
                    model_id: model.modelID,
                    time_created: now - index,
                  })),
                )
                .onConflictDoNothing()
                .run()
            }),
          { behavior: "immediate" },
        )
      }

      return Service.of({
        list: Effect.fn("ModelFavorites.list")(function* () {
          return yield* database.db
            .select({ providerID: ModelFavoriteTable.provider_id, modelID: ModelFavoriteTable.model_id })
            .from(ModelFavoriteTable)
            .orderBy(
              desc(ModelFavoriteTable.time_created),
              asc(ModelFavoriteTable.provider_id),
              asc(ModelFavoriteTable.model_id),
            )
            .all()
            .pipe(Effect.orDie)
        }),
        set: Effect.fn("ModelFavorites.set")(function* (model, favorite) {
          if (!favorite) {
            yield* database.db
              .delete(ModelFavoriteTable)
              .where(
                and(
                  eq(ModelFavoriteTable.provider_id, model.providerID),
                  eq(ModelFavoriteTable.model_id, model.modelID),
                ),
              )
              .run()
              .pipe(Effect.orDie)
            return
          }
          yield* database.db
            .insert(ModelFavoriteTable)
            .values({
              provider_id: model.providerID,
              model_id: model.modelID,
              time_created: yield* Clock.currentTimeMillis,
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
        }),
      })
    }).pipe(Effect.orDie),
  )

export const node = makeGlobalNode({
  service: Service,
  layer: layer(Global.Path.state),
  deps: [Database.node, FSUtil.node],
})

export function store(input: { database?: string; state?: string } = {}): Store {
  const runtime = makeRuntime(
    Service,
    layer(input.state ?? Global.Path.state).pipe(
      Layer.provide(
        Layer.mergeAll(
          input.database ? Layer.fresh(Database.layerFromPath(input.database)) : LayerNode.compile(Database.node),
          LayerNode.compile(FSUtil.node),
        ),
      ),
    ),
  )
  return {
    list: () => runtime.runPromise((service) => service.list()),
    set: (model, favorite) => runtime.runPromise((service) => service.set(model, favorite)),
    dispose: () => runtime.dispose(),
  }
}

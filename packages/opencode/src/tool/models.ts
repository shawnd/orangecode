import path from "path"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { ModelFavorites } from "@opencode-ai/core/model-favorites"
import { Provider } from "@/provider/provider"
import * as Tool from "./tool"
import { ModelsFormat } from "./models-format"
import { TaskModel } from "./task-model"
import LIST from "./models.txt"
import SEARCH from "./models-search.txt"

export const ListParameters = Schema.Struct({
  provider: Schema.optional(Schema.String).annotate({
    description: "Only include models from this provider id",
  }),
})

export const SearchParameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "The user's model or setup wording, for example grok 4.7 max, astra, or sol 5.6",
  }),
})

export const ModelsTool = Tool.define(
  "models",
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const fs = yield* FSUtil.Service
    const favorites = yield* ModelFavorites.Service
    return {
      description: LIST,
      parameters: ListParameters,
      execute: (params: Schema.Schema.Type<typeof ListParameters>) =>
        Effect.gen(function* () {
          const saved = yield* readSaved(fs, Global.Path.state, favorites)
          const output = ModelsFormat.formatList({
            models: candidates(yield* provider.list()),
            saved,
            provider: params.provider,
          })
          return {
            title: params.provider ? `Models ${params.provider}` : "Models",
            output,
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const ModelsSearchTool = Tool.define(
  "models_search",
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const fs = yield* FSUtil.Service
    const favorites = yield* ModelFavorites.Service
    return {
      description: SEARCH,
      parameters: SearchParameters,
      execute: (params: Schema.Schema.Type<typeof SearchParameters>) =>
        Effect.gen(function* () {
          const saved = yield* readSaved(fs, Global.Path.state, favorites)
          const output = ModelsFormat.formatSearch({
            query: params.query,
            models: candidates(yield* provider.list()),
            saved,
          })
          return {
            title: `Search models ${params.query}`,
            output,
            metadata: { query: params.query },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const readSaved = Effect.fn("Models.readSaved")(function* (
  fs: FSUtil.Interface,
  directory: string,
  favorites: ModelFavorites.Interface,
) {
  const saved = yield* fs.readJson(path.join(directory, "model.json")).pipe(
    Effect.map(ModelsFormat.parseSaved),
    Effect.catch(() => Effect.succeed(ModelsFormat.parseSaved(undefined))),
  )
  return { ...saved, favorite: yield* favorites.list() }
})

function candidates(providers: Record<string, Provider.Info>): TaskModel.Candidate[] {
  return Object.values(providers).flatMap((item) =>
    Object.values(item.models).map((model) => ({
      providerID: model.providerID,
      modelID: model.id,
      name: model.name,
      releaseDate: model.release_date,
      variants: Object.keys(model.variants ?? {}),
    })),
  )
}

export * as Models from "./models"

import { TaskModel } from "./task-model"

const LIST_OTHER = 24
const SEARCH_LIMIT = 12

export interface SavedModel {
  providerID: string
  modelID: string
}

export interface SavedModels {
  favorite: SavedModel[]
  recent: SavedModel[]
  variant: Record<string, string>
}

export function parseSaved(value: unknown): SavedModels {
  if (!isRecord(value)) return { favorite: [], recent: [], variant: {} }
  return {
    favorite: modelsOf(value.favorite),
    recent: modelsOf(value.recent),
    variant: variantsOf(value.variant),
  }
}

export function formatList(input: {
  models: readonly TaskModel.Candidate[]
  saved: SavedModels
  provider?: string
}): string {
  const models = filterProvider(input.models, input.provider)
  if (models.length === 0) {
    return input.provider ? `No connected models for provider "${input.provider}".` : "No connected models."
  }
  const favorite = pick(models, input.saved.favorite)
  const recent = pick(models, input.saved.recent).filter((model) => !includes(favorite, model))
  const pinned = new Set([...favorite, ...recent].map(key))
  const other = models
    .filter((model) => !pinned.has(key(model)))
    .sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") || key(a).localeCompare(key(b)))
  const shown = other.slice(0, LIST_OTHER)
  const more = other.length - shown.length
  return [
    section("Favorites", favorite, input.saved, "favorite"),
    section("Recent", recent, input.saved, "recent"),
    section("Other", shown, input.saved),
    more > 0 ? `…and ${more} more. Use models_search to find a specific setup.` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join("\n\n")
}

export function formatSearch(input: {
  query: string
  models: readonly TaskModel.Candidate[]
  saved: SavedModels
}): string {
  const found = TaskModel.search(input.query, input.models, input.models.length)
  const ranked = [...found.hits].sort((a, b) => {
    const favorite = Number(includes(input.saved.favorite, b.model)) - Number(includes(input.saved.favorite, a.model))
    if (favorite !== 0) return favorite
    const score = b.score - a.score
    if (score !== 0) return score
    const pinned = pin(a.model, input.saved) - pin(b.model, input.saved)
    if (pinned !== 0) return pinned
    return key(a.model).localeCompare(key(b.model))
  })
  const shown = ranked.slice(0, SEARCH_LIMIT)
  if (shown.length === 0) return `No models matched "${input.query.trim()}".`
  const lines = shown.map((hit) => line(hit.model, input.saved, mark(hit.model, input.saved)))
  return [found.effort ? `Variant: ${found.effort}` : undefined, ...lines]
    .filter((part) => part !== undefined)
    .join("\n")
}

function filterProvider(models: readonly TaskModel.Candidate[], provider: string | undefined) {
  const id = provider?.trim().toLowerCase()
  if (!id) return [...models]
  return models.filter((model) => model.providerID.toLowerCase() === id)
}

function pick(models: readonly TaskModel.Candidate[], saved: readonly SavedModel[]) {
  return saved.flatMap((item) => {
    const model = models.find((candidate) => same(candidate, item))
    return model ? [model] : []
  })
}

function section(title: string, models: readonly TaskModel.Candidate[], saved: SavedModels, mark?: string) {
  if (models.length === 0) return
  return [title + ":", ...models.map((model) => line(model, saved, mark))].join("\n")
}

function line(model: TaskModel.Candidate, saved: SavedModels, mark?: string) {
  const variants = [...model.variants].sort((a, b) => a.localeCompare(b))
  const suffix = variants.length === 0 ? "" : ` (${variants.join(", ")})`
  const savedVariant = saved.variant[key(model)]
  const savedText = savedVariant ? ` saved:${savedVariant}` : ""
  const tag = mark ? ` ${mark}` : ""
  return `- ${key(model)} ${model.name}${suffix}${savedText}${tag}`
}

function mark(model: TaskModel.Candidate, saved: SavedModels) {
  if (includes(saved.favorite, model)) return "favorite"
  if (includes(saved.recent, model)) return "recent"
  return
}

function pin(model: TaskModel.Candidate, saved: SavedModels) {
  if (includes(saved.favorite, model)) return 0
  if (includes(saved.recent, model)) return 1
  return 2
}

function includes(
  models: readonly { providerID: string; modelID: string }[],
  model: { providerID: string; modelID: string },
) {
  return models.some((item) => same(item, model))
}

function same(left: { providerID: string; modelID: string }, right: { providerID: string; modelID: string }) {
  return (
    left.providerID.toLowerCase() === right.providerID.toLowerCase() &&
    left.modelID.toLowerCase() === right.modelID.toLowerCase()
  )
}

function key(model: { providerID: string; modelID: string }) {
  return `${model.providerID}/${model.modelID}`
}

function modelsOf(value: unknown): SavedModel[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    if (typeof item.providerID !== "string" || typeof item.modelID !== "string") return []
    return [{ providerID: item.providerID, modelID: item.modelID }]
  })
}

function variantsOf(value: unknown) {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, item]) => (typeof item === "string" ? [[name, item] as const] : [])),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export * as ModelsFormat from "./models-format"

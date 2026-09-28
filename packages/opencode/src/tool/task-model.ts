export interface Candidate {
  providerID: string
  modelID: string
  name: string
  releaseDate?: string
  variants: readonly string[]
}

export interface Resolved {
  providerID: string
  modelID: string
  variant?: string
}

export type ResolveResult = { ok: true; model: Resolved } | { ok: false; error: string }

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
const EFFORT = new Set<string>(EFFORTS)
const MARGIN = 20

export function resolve(input: {
  query?: string
  variant?: string
  current?: { providerID: string; modelID: string }
  preferProviderID?: string
  models: readonly Candidate[]
}): ResolveResult {
  const variant = input.variant?.trim()
  const query = normalize(input.query)
  if (!query && !variant) return { ok: false, error: "Model name is missing." }
  if (!query || EFFORT.has(query.toLowerCase())) {
    return applyVariant(input.current, input.models, variant || query)
  }

  const exact = findExact(query, input.models, input.preferProviderID)
  if (exact) return finish(exact, input.models, variant)

  const peeled = peel(query)
  if (peeled) {
    const match = matchQuery(peeled.text, input.models, input.preferProviderID)
    if (isMatch(match)) return finish(match, input.models, variant ?? peeled.effort)
    if (match) return match
  }

  const match = matchQuery(query, input.models, input.preferProviderID)
  if (isMatch(match)) return finish(match, input.models, variant)
  if (match) return match
  return { ok: false, error: notFound(query, input.models) }
}

export interface SearchHit {
  model: Candidate
  score: number
}

export function search(
  query: string,
  models: readonly Candidate[],
  limit = 40,
): {
  text: string
  effort?: string
  hits: SearchHit[]
} {
  const normalized = normalize(query)
  if (!normalized) return { text: "", hits: [] }
  if (EFFORT.has(normalized.toLowerCase())) {
    const effort = normalized.toLowerCase()
    return {
      text: normalized,
      effort,
      hits: models
        .filter((model) => model.variants.some((item) => same(item, effort)))
        .map((model) => ({ model, score: 1 }))
        .slice(0, limit),
    }
  }

  const peeled = peel(normalized)
  const text = peeled?.text ?? normalized
  const queryTokens = tokens(text)
  return {
    text,
    effort: peeled?.effort,
    hits: models
      .map((model) => ({ model, score: searchScore(model, queryTokens) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || label(a.model).localeCompare(label(b.model)))
      .slice(0, limit),
  }
}

export function formatSetups(models: readonly Candidate[], limit = 40): string | undefined {
  if (models.length === 0) return
  const ranked = [...models].sort((a, b) => {
    const date = (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "")
    if (date !== 0) return date
    return label(a).localeCompare(label(b))
  })
  const lines = ranked.slice(0, limit).map((model) => {
    const variants = sortVariants(model.variants)
    return variants.length === 0 ? `- ${label(model)}` : `- ${label(model)} (${variants.join(", ")})`
  })
  const more =
    models.length > limit ? [`- …and ${models.length - limit} more. Short names and provider/model still resolve.`] : []
  return ["Connected LLM setups for the model parameter:", ...lines, ...more].join("\n")
}

function normalize(query: string | undefined) {
  const text = query?.trim()
  if (!text) return
  return text.replace(/^use\s+/i, "").trim()
}

function peel(query: string) {
  const match = query.match(/^(.*?)(?:\s+|[-_])(none|minimal|low|medium|high|xhigh|max)$/i)
  if (!match) return
  const text = match[1]?.trim().replace(/[-_\s]+$/, "")
  const effort = match[2]?.toLowerCase()
  if (!text || !effort) return
  return { text, effort }
}

function findExact(
  query: string,
  models: readonly Candidate[],
  preferProviderID: string | undefined,
): Candidate | ResolveResult | undefined {
  if (query.includes("/")) {
    const slash = query.indexOf("/")
    const providerID = query.slice(0, slash)
    const modelID = query.slice(slash + 1)
    const hits = models.filter((model) => same(model.providerID, providerID) && same(model.modelID, modelID))
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) return ambiguous(query, hits)
    return
  }

  const hits = models.filter((model) => same(model.modelID, query))
  if (hits.length === 0) return
  return pick(query, hits, preferProviderID)
}

function matchQuery(query: string, models: readonly Candidate[], preferProviderID: string | undefined) {
  const exact = findExact(query, models, preferProviderID)
  if (exact) return exact
  const queryTokens = tokens(query)
  if (queryTokens.length === 0) return
  const ranked = models
    .map((model) => ({ model, score: score(model, queryTokens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || label(a.model).localeCompare(label(b.model)))
  const best = ranked[0]
  if (!best) return
  const close = ranked.filter((item) => best.score - item.score <= MARGIN).map((item) => item.model)
  return pick(query, close, preferProviderID)
}

function pick(
  query: string,
  hits: readonly Candidate[],
  preferProviderID: string | undefined,
): Candidate | ResolveResult {
  if (hits.length === 1) return hits[0]!
  const preferred = preferProviderID ? hits.filter((model) => same(model.providerID, preferProviderID)) : []
  if (preferred.length === 1) return preferred[0]!
  return ambiguous(query, preferred.length > 1 ? preferred : hits)
}

function finish(
  match: Candidate | ResolveResult,
  models: readonly Candidate[],
  variant: string | undefined,
): ResolveResult {
  if (!isMatch(match)) return match
  return applyVariant(match, models, variant)
}

function applyVariant(
  current: { providerID: string; modelID: string } | undefined,
  models: readonly Candidate[],
  variant: string | undefined,
): ResolveResult {
  if (!current) return { ok: false, error: "Model name is missing." }
  const model = models.find((item) => same(item.providerID, current.providerID) && same(item.modelID, current.modelID))
  if (!variant) {
    return {
      ok: true,
      model: {
        providerID: model?.providerID ?? current.providerID,
        modelID: model?.modelID ?? current.modelID,
      },
    }
  }
  if (!model) {
    return {
      ok: true,
      model: { providerID: current.providerID, modelID: current.modelID, variant },
    }
  }
  const canonical = model.variants.find((item) => same(item, variant))
  if (!canonical) {
    const available = sortVariants(model.variants)
    const suffix = available.length === 0 ? "" : ` Available variants: ${available.join(", ")}.`
    return {
      ok: false,
      error: `Model ${label(model)} has no "${variant}" variant.${suffix}`,
    }
  }
  return { ok: true, model: { providerID: model.providerID, modelID: model.modelID, variant: canonical } }
}

function isMatch(value: Candidate | ResolveResult | undefined): value is Candidate {
  return !!value && !("ok" in value)
}

function searchScore(model: Candidate, queryTokens: readonly string[]) {
  if (queryTokens.length === 0) return 0
  const full = score(model, queryTokens)
  if (full > 0) return full
  const bag = new Set([...tokens(model.modelID), ...tokens(model.name), ...tokens(model.providerID)])
  return queryTokens.filter((token) => bag.has(token)).length * 8
}

function score(model: Candidate, queryTokens: readonly string[]) {
  const idTokens = tokens(model.modelID)
  const bag = new Set([...idTokens, ...tokens(model.name), ...tokens(model.providerID)])
  if (!queryTokens.every((token) => bag.has(token))) return 0
  const id = new Set(idTokens)
  const extra = idTokens.filter((token) => !queryTokens.includes(token)).length
  const exact = extra === 0 && idTokens.length === queryTokens.length && queryTokens.every((token) => id.has(token))
  return (
    100 +
    queryTokens.filter((token) => id.has(token)).length * 10 +
    queryTokens.filter((token) => tokens(model.name).includes(token)).length * 2 +
    (exact ? 50 : 0) -
    extra * 30
  )
}

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z]+|\d+(?:\.\d+)*/g) ?? []
}

function same(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase()
}

function label(model: Candidate) {
  return `${model.providerID}/${model.modelID}`
}

function ambiguous(query: string, models: readonly Candidate[]): ResolveResult {
  const shown = models.slice(0, 8).map(label).join(", ")
  const more = models.length > 8 ? ", …" : ""
  return {
    ok: false,
    error: `Model "${query}" matches multiple setups: ${shown}${more}. Pass provider/model.`,
  }
}

function notFound(query: string, models: readonly Candidate[]) {
  const queryTokens = tokens(query)
  const hints = [...models]
    .map((model) => ({
      model,
      overlap: queryTokens.filter((token) =>
        new Set([...tokens(model.modelID), ...tokens(model.name), ...tokens(model.providerID)]).has(token),
      ).length,
    }))
    .filter((item) => item.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || label(a.model).localeCompare(label(b.model)))
    .slice(0, 5)
    .map((item) => label(item.model))
  const suffix = hints.length === 0 ? "" : ` Did you mean: ${hints.join(", ")}?`
  return `Model not found: "${query}".${suffix}`
}

function sortVariants(variants: readonly string[]) {
  return [...variants].sort((a, b) => effortRank(a) - effortRank(b) || a.localeCompare(b))
}

function effortRank(value: string) {
  for (const [index, effort] of EFFORTS.entries()) {
    if (effort === value) return index
  }
  return EFFORTS.length
}

export * as TaskModel from "./task-model"

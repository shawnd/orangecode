import { describe, expect, test } from "bun:test"
import { TaskModel } from "../../src/tool/task-model"

const models: TaskModel.Candidate[] = [
  { providerID: "xai", modelID: "grok-4.7", name: "Grok 4.7", variants: ["low", "high", "max"] },
  { providerID: "xai", modelID: "grok-4.7-fast", name: "Grok 4.7 Fast", variants: ["low", "high", "max"] },
  { providerID: "openai", modelID: "gpt-6-astra", name: "GPT-6 Astra", variants: ["high", "xhigh"] },
  {
    providerID: "openai",
    modelID: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    variants: ["low", "medium", "high", "xhigh", "max"],
  },
  { providerID: "openai", modelID: "gpt-5.6-sol-pro", name: "GPT-5.6 Sol Pro", variants: ["high"] },
  { providerID: "openai", modelID: "gpt-5.6-luna", name: "GPT-5.6 Luna", variants: ["high"] },
  { providerID: "openai", modelID: "gpt-6-sol", name: "GPT-6 Sol", variants: [] },
  { providerID: "opencode", modelID: "gpt-5.6-sol", name: "GPT-5.6 Sol", variants: ["high", "max"] },
  { providerID: "openai", modelID: "grok-4.7-max", name: "Literal Max", variants: [] },
]

const resolve = (query: string, extra?: Partial<Parameters<typeof TaskModel.resolve>[0]>) =>
  TaskModel.resolve({ query, models, ...extra })

describe("task model", () => {
  test("resolves grok 4.7 max", () => {
    expect(resolve("grok 4.7 max")).toEqual({
      ok: true,
      model: { providerID: "xai", modelID: "grok-4.7", variant: "max" },
    })
  })

  test("resolves astra and sol 5.6", () => {
    expect(resolve("astra")).toEqual({
      ok: true,
      model: { providerID: "openai", modelID: "gpt-6-astra" },
    })
    expect(resolve("sol 5.6", { preferProviderID: "openai" })).toEqual({
      ok: true,
      model: { providerID: "openai", modelID: "gpt-5.6-sol" },
    })
  })

  test("accepts provider/model and a separate variant", () => {
    expect(resolve("xai/grok-4.7", { variant: "max" })).toEqual({
      ok: true,
      model: { providerID: "xai", modelID: "grok-4.7", variant: "max" },
    })
  })

  test("prefers an exact model id over a peeled effort", () => {
    expect(resolve("grok-4.7-max")).toEqual({
      ok: true,
      model: { providerID: "openai", modelID: "grok-4.7-max" },
    })
  })

  test("asks for provider/model when the same id is connected twice", () => {
    const result = resolve("sol 5.6")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("openai/gpt-5.6-sol")
    expect(result.error).toContain("opencode/gpt-5.6-sol")
    expect(result.error).not.toContain("sol-pro")
  })

  test("uses the parent provider to break an equal match", () => {
    expect(resolve("gpt-5.6-sol", { preferProviderID: "opencode" })).toEqual({
      ok: true,
      model: { providerID: "opencode", modelID: "gpt-5.6-sol" },
    })
  })

  test("rejects an unknown variant and an unknown model", () => {
    const variant = resolve("grok 4.7", { variant: "ultra" })
    expect(variant.ok).toBe(false)
    if (!variant.ok) expect(variant.error).toContain("Available variants: low, high, max")

    const missing = resolve("not-a-model")
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toContain('Model not found: "not-a-model"')
  })

  test("applies a bare effort to the current model", () => {
    expect(
      resolve("max", {
        current: { providerID: "xai", modelID: "grok-4.7" },
      }),
    ).toEqual({
      ok: true,
      model: { providerID: "xai", modelID: "grok-4.7", variant: "max" },
    })
  })

  test("searches by the user's wording and keeps closer matches first", () => {
    const found = TaskModel.search("grok 4.7 max", models)
    expect(found.effort).toBe("max")
    expect(found.hits[0]?.model).toMatchObject({ providerID: "xai", modelID: "grok-4.7" })
    expect(found.hits.some((hit) => hit.model.modelID === "grok-4")).toBe(false)

    const astra = TaskModel.search("astra", models)
    expect(astra.hits[0]?.model.modelID).toBe("gpt-6-astra")

    const sol = TaskModel.search("sol 5.6", models)
    expect(sol.hits[0]?.model.modelID).toBe("gpt-5.6-sol")
    expect(sol.hits[0]?.score).toBeGreaterThan(
      sol.hits.find((hit) => hit.model.modelID === "gpt-5.6-sol-pro")?.score ?? 0,
    )
  })

  test("lists newest setups first", () => {
    const text = TaskModel.formatSetups([
      { providerID: "openai", modelID: "old", name: "Old", releaseDate: "2024-01-01", variants: [] },
      { providerID: "xai", modelID: "new", name: "New", releaseDate: "2026-01-01", variants: ["max", "low"] },
    ])
    expect(text?.indexOf("xai/new")).toBeLessThan(text?.indexOf("openai/old") ?? 0)
    expect(text).toContain("xai/new (low, max)")
  })
})

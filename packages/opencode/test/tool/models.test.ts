import { describe, expect, test } from "bun:test"
import { ModelsFormat } from "../../src/tool/models-format"
import type { TaskModel } from "../../src/tool/task-model"

const models: TaskModel.Candidate[] = [
  { providerID: "xai", modelID: "grok-4.7", name: "Grok 4.7", releaseDate: "2026-08-01", variants: ["low", "max"] },
  { providerID: "openai", modelID: "gpt-6-astra", name: "GPT-6 Astra", releaseDate: "2026-07-01", variants: ["high"] },
  { providerID: "openai", modelID: "gpt-5.6-sol", name: "GPT-5.6 Sol", releaseDate: "2026-06-01", variants: ["high"] },
  { providerID: "openai", modelID: "gpt-5.6-luna", name: "GPT-5.6 Luna", releaseDate: "2026-05-01", variants: [] },
]

const saved = ModelsFormat.parseSaved({
  favorite: [{ providerID: "xai", modelID: "grok-4.7" }],
  recent: [
    { providerID: "openai", modelID: "gpt-5.6-sol" },
    { providerID: "xai", modelID: "grok-4.7" },
  ],
  variant: { "xai/grok-4.7": "max" },
})

describe("models tool", () => {
  test("parses favorites and recent models", () => {
    expect(saved.favorite).toEqual([{ providerID: "xai", modelID: "grok-4.7" }])
    expect(saved.variant["xai/grok-4.7"]).toBe("max")
    expect(ModelsFormat.parseSaved(undefined)).toEqual({ favorite: [], recent: [], variant: {} })
  })

  test("lists favorites before recent and other models", () => {
    const text = ModelsFormat.formatList({ models, saved })
    expect(text.indexOf("Favorites:")).toBeLessThan(text.indexOf("Recent:"))
    expect(text.indexOf("Recent:")).toBeLessThan(text.indexOf("Other:"))
    expect(text).toContain("- xai/grok-4.7 Grok 4.7 (low, max) saved:max favorite")
    expect(text).toContain("- openai/gpt-5.6-sol GPT-5.6 Sol (high) recent")
    expect(text).not.toContain("xai/grok-4.7 Grok 4.7 (low, max) saved:max recent")
    expect(text.indexOf("gpt-6-astra")).toBeLessThan(text.indexOf("gpt-5.6-luna"))
  })

  test("searches the user's wording and marks matching favorites", () => {
    const text = ModelsFormat.formatSearch({ query: "grok 4.7 max", models, saved })
    expect(text.startsWith("Variant: max")).toBe(true)
    expect(text).toContain("xai/grok-4.7")
    expect(text).toContain("favorite")
  })

  test("puts a matching favorite ahead of an equal match", () => {
    const text = ModelsFormat.formatSearch({
      query: "sol 5.6",
      models: [...models, { providerID: "opencode", modelID: "gpt-5.6-sol", name: "GPT-5.6 Sol", variants: ["high"] }],
      saved: {
        ...saved,
        favorite: [{ providerID: "opencode", modelID: "gpt-5.6-sol" }],
      },
    })
    expect(text.indexOf("opencode/gpt-5.6-sol")).toBeLessThan(text.indexOf("openai/gpt-5.6-sol"))
  })

  test("reports no match", () => {
    expect(ModelsFormat.formatSearch({ query: "not-a-model", models, saved })).toBe('No models matched "not-a-model".')
  })

  test("prefers a favorite when provider naming lowers its search score", () => {
    const text = ModelsFormat.formatSearch({
      query: "sol 5.6",
      models: [...models, { providerID: "opencode", modelID: "gpt-5.6-sol", name: "Sol", variants: ["high"] }],
      saved: {
        ...saved,
        favorite: [{ providerID: "opencode", modelID: "gpt-5.6-sol" }],
      },
    })
    expect(text.split("\n")[0]).toContain("opencode/gpt-5.6-sol")
  })

  test("ranks favorites before truncating search candidates", () => {
    const text = ModelsFormat.formatSearch({
      query: "sol 5.6",
      models: Array.from({ length: 50 }, (_, index) => ({
        providerID: `provider-${String(index).padStart(2, "0")}`,
        modelID: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        variants: ["high"],
      })),
      saved: {
        ...saved,
        favorite: [{ providerID: "provider-49", modelID: "gpt-5.6-sol" }],
      },
    })
    expect(text.split("\n")[0]).toContain("provider-49/gpt-5.6-sol")
    expect(text.split("\n")).toHaveLength(12)
  })
})

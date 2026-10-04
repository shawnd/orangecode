import { expect, test } from "bun:test"
import { startupPresentation } from "../../src/startup/presentation"
import { clickStartupSelection } from "../../src/startup/controls"
import type { StartupSlashDraft } from "../../src/startup/slashes"

test("cached mouse controls preview forward/reverse cycling and preserve directional actions for live replay", () => {
  const presentation = startupPresentation()
  presentation.selection = {
    directory: "/project",
    providerID: "test",
    modelID: "one",
    agentID: "build",
    agent: "Build",
    model: "One",
    provider: "Test",
    variant: "default",
  }
  presentation.controls = {
    directory: "/project",
    providerID: "test",
    models: [
      { id: "one", name: "One", variants: ["high", "low"] },
      { id: "two", name: "Two", variants: ["fast"], variant: "fast" },
    ],
    agents: [
      { id: "build", label: "Build", color: "#111111", modelID: "one" },
      { id: "plan", label: "Plan", color: "#222222", modelID: "one" },
    ],
  }
  const draft: StartupSlashDraft = { text: "typing", cursor: 6 }
  clickStartupSelection(presentation, draft, "variant", 1)
  expect(presentation.selection.variant).toBe("high")
  clickStartupSelection(presentation, draft, "model", 1)
  expect(presentation.selection.model).toBe("Two")
  expect(presentation.selection.variant).toBe("fast")
  clickStartupSelection(presentation, draft, "variant", -1)
  expect(presentation.selection.variant).toBe("default")
  clickStartupSelection(presentation, draft, "agent", -1)
  expect(presentation.selection.agent).toBe("Plan")
  expect(presentation.selection.model).toBe("One")
  expect(presentation.selection.variant).toBe("high")
  expect(presentation.selection.agentColor).toBe("#222222")
  expect(draft.changes).toEqual([
    { target: "variant", direction: 1 },
    { target: "model", direction: 1 },
    { target: "variant", direction: -1 },
    { target: "agent", direction: -1 },
  ])
  expect(draft.text).toBe("typing")
  clickStartupSelection(presentation, draft, "provider")
  expect(draft.command).toEqual({ name: "provider.connect", display: "/connect", prefix: "" })
  expect(draft.text).toBe("typing")
})

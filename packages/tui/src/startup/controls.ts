import type { StartupPresentation } from "./presentation"
import type { StartupSlashDraft } from "./slashes"

export type StartupControlTarget = "agent" | "model" | "variant"
export type StartupSelectionChange =
  | { target: StartupControlTarget; direction: 1 | -1 }
  | { target: "select-model"; providerID: string; modelID: string }
export type StartupControlModel = {
  id: string
  name: string
  variants: string[]
  variant?: string
  releaseDate?: string
  free?: boolean
  disabled?: boolean
  deprecated?: boolean
}
export type StartupControls = {
  directory: string
  providerID: string
  models: StartupControlModel[]
  agents: { id: string; label: string; color: string; modelID?: string }[]
}

// Serialized into the raw-input worker. Preview from display-only data; replay
// the actual directional actions against live state at handoff.
export function clickStartupSelection(
  presentation: StartupPresentation,
  state: StartupSlashDraft,
  target: StartupControlTarget | "provider",
  direction: 1 | -1 = 1,
) {
  if (!presentation.selection) return false
  if (target === "provider") {
    state.command = { name: "provider.connect", display: "/connect", prefix: "" }
    return true
  }
  if ((state.changes?.length ?? 0) >= 64) return false
  state.changes = [...(state.changes ?? []), { target, direction: target === "agent" ? 1 : direction }]
  const controls = presentation.controls
  if (!controls) return true
  const selection = presentation.selection
  if (target === "agent") {
    const index = controls.agents.findIndex(
      (agent) => agent.id === selection.agentID || agent.label === selection.agent,
    )
    const next = controls.agents[(index + 1 + controls.agents.length) % controls.agents.length]
    if (!next) return true
    const model = controls.models.find((model) => model.id === next.modelID)
    presentation.selection = {
      ...selection,
      agentID: next.id,
      agent: next.label,
      agentColor: next.color,
      ...(model ? { modelID: model.id, model: model.name, variant: model.variant ?? "default" } : {}),
    }
    presentation.border = next.color
    return true
  }
  if (controls.providerID !== selection.providerID) return true
  const index = controls.models.findIndex((model) => model.id === selection.modelID || model.name === selection.model)
  if (target === "model") {
    const next = controls.models[(index + direction + controls.models.length) % controls.models.length]
    if (!next) return true
    presentation.selection = { ...selection, modelID: next.id, model: next.name, variant: next.variant ?? "default" }
    presentation.controls = {
      ...controls,
      agents: controls.agents.map((agent) => (agent.id === selection.agentID ? { ...agent, modelID: next.id } : agent)),
    }
    return true
  }
  const model = controls.models[index]
  if (!model?.variants.length) return true
  const options = [undefined, ...model.variants]
  const current = options.indexOf(model.variant)
  const next = options[(current + direction + options.length) % options.length]
  const variant = next ?? (model.variants.includes("default") ? "default" : undefined)
  presentation.controls = {
    ...controls,
    models: controls.models.map((item) => (item.id === model.id ? { ...item, variant } : item)),
  }
  presentation.selection = { ...selection, variant: variant ?? "default" }
  return true
}

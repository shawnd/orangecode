import type { StartupSlash } from "./slashes"
import type { StartupControls, StartupControlTarget } from "./controls"

// This module is also serialized into the first-input worker. Keep it free of
// runtime imports (in particular Solid, OpenTUI, config and the backend).
export type StartupPresentation = ReturnType<typeof startupPresentation>
export type StartupInputBindings = { submit: string[]; newline: string[] }
export type StartupSelection = {
  directory: string
  agent: string
  model: string
  provider: string
  variant: string
  agentColor?: string
  variantColor?: string
  providerID?: string
  modelID?: string
  agentID?: string
}

export function startupPresentation(value?: unknown) {
  const fallback = {
    version: 1,
    background: "#0a0a0a",
    backgroundElement: "#1e1e1e",
    text: "#eeeeee",
    textMuted: "#808080",
    border: "#5c9cf5",
    menuBorder: "#5c9cf5",
    backgroundMenu: "#1e1e1e",
    primary: "#fab283",
    selectedText: "#0a0a0a",
    warning: "#f5a742",
    maxWidth: 75 as number | "auto",
    maxHeight: 0,
    bottomHeight: 4,
    footerHeight: 3,
    cursorStyle: "block" as "block" | "underline" | "line" | "default",
    cursorBlinking: true,
    selection: undefined as StartupSelection | undefined,
    slashes: undefined as { directory: string; items: StartupSlash[] } | undefined,
    controls: undefined as StartupControls | undefined,
    mouse: true,
    inputBindings: { submit: ["return"], newline: ["shift+return", "ctrl+return", "alt+return", "ctrl+j"] },
  }
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1) return fallback
  const result = { ...fallback }
  if ("cursorStyle" in value) {
    if (!["block", "underline", "line", "default"].includes(String(value.cursorStyle))) return fallback
    result.cursorStyle = value.cursorStyle as typeof result.cursorStyle
  }
  if ("cursorBlinking" in value) {
    if (typeof value.cursorBlinking !== "boolean") return fallback
    result.cursorBlinking = value.cursorBlinking
  }
  if ("mouse" in value) {
    if (typeof value.mouse !== "boolean") return fallback
    result.mouse = value.mouse
  }
  if ("inputBindings" in value && value.inputBindings && typeof value.inputBindings === "object") {
    const bindings = value.inputBindings as Record<string, unknown>
    if (
      ["submit", "newline"].every(
        (key) =>
          Array.isArray(bindings[key]) &&
          bindings[key].length <= 16 &&
          bindings[key].every(
            (key: unknown) => typeof key === "string" && key.length <= 128 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(key),
          ),
      )
    )
      result.inputBindings = { submit: bindings.submit as string[], newline: bindings.newline as string[] }
  }
  for (const key of ["background", "backgroundElement", "text", "textMuted", "border"] as const) {
    if (!(key in value)) return fallback
    const color = (value as Record<string, unknown>)[key]
    if (typeof color !== "string") return fallback
    if (
      !/^#[\da-f]{6}$/i.test(color) &&
      !((key === "background" || key === "backgroundElement") && color === "transparent")
    )
      return fallback
    result[key] = color
  }
  for (const key of ["menuBorder", "backgroundMenu", "primary", "selectedText", "warning"] as const) {
    if (!(key in value)) continue
    const color = (value as Record<string, unknown>)[key]
    if (
      typeof color !== "string" ||
      (!/^#[\da-f]{6}$/i.test(color) && !(key === "backgroundMenu" && color === "transparent"))
    )
      return fallback
    result[key] = color
  }
  for (const key of ["maxWidth", "maxHeight", "bottomHeight", "footerHeight"] as const) {
    const size = (value as Record<string, unknown>)[key]
    if (key === "maxWidth" && size === "auto") {
      result.maxWidth = size
      continue
    }
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0 || size > 1000) return fallback
    if (key === "maxWidth" && size < 6) return fallback
    result[key] = size
  }
  if ("selection" in value && value.selection && typeof value.selection === "object") {
    const selection = value.selection as Record<string, unknown>
    if (
      ["directory", "agent", "model", "provider", "variant"].every(
        (key) =>
          typeof selection[key] === "string" &&
          selection[key].length > 0 &&
          selection[key].length <= (key === "directory" ? 1024 : 128) &&
          !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(selection[key]),
      )
    )
      result.selection = {
        directory: selection.directory as string,
        agent: selection.agent as string,
        model: selection.model as string,
        provider: selection.provider as string,
        variant: selection.variant as string,
        ...(typeof selection.agentColor === "string" && /^#[\da-f]{6}$/i.test(selection.agentColor)
          ? { agentColor: selection.agentColor }
          : {}),
        ...(typeof selection.variantColor === "string" && /^#[\da-f]{6}$/i.test(selection.variantColor)
          ? { variantColor: selection.variantColor }
          : {}),
        ...Object.fromEntries(
          ["providerID", "modelID", "agentID"].flatMap((key) =>
            typeof selection[key] === "string" &&
            selection[key].length <= 128 &&
            !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(selection[key])
              ? [[key, selection[key]]]
              : [],
          ),
        ),
      }
  }
  if ("slashes" in value && value.slashes && typeof value.slashes === "object") {
    const slashes = value.slashes as Record<string, unknown>
    if (
      typeof slashes.directory === "string" &&
      slashes.directory.length <= 1024 &&
      !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(slashes.directory) &&
      Array.isArray(slashes.items) &&
      slashes.items.length <= 128
    ) {
      const items = slashes.items.flatMap((value: unknown): StartupSlash[] => {
        if (!value || typeof value !== "object") return []
        const item = value as Record<string, unknown>
        const token = (value: unknown) =>
          typeof value === "string" && value.length <= 128 && /^\/[^\s\p{Cc}]+$/u.test(value)
        if (!token(item.display)) return []
        if (item.value !== undefined && !token(item.value)) return []
        if (
          item.command !== undefined &&
          (typeof item.command !== "string" || !/^[^\s\p{Cc}]{1,128}$/u.test(item.command))
        )
          return []
        if (
          item.description !== undefined &&
          (typeof item.description !== "string" ||
            item.description.length > 256 ||
            /[\p{Cc}\p{Zl}\p{Zp}]/u.test(item.description))
        )
          return []
        if (
          item.aliases !== undefined &&
          (!Array.isArray(item.aliases) || item.aliases.length > 8 || !item.aliases.every(token))
        )
          return []
        return [
          {
            display: item.display as string,
            ...(item.value !== undefined ? { value: item.value as string } : {}),
            ...(item.command !== undefined ? { command: item.command as string } : {}),
            ...(item.description !== undefined ? { description: item.description as string } : {}),
            ...(item.aliases !== undefined ? { aliases: item.aliases as string[] } : {}),
          },
        ]
      })
      result.slashes = { directory: slashes.directory, items }
    }
  }
  if ("controls" in value && value.controls && typeof value.controls === "object") {
    const controls = value.controls as Record<string, unknown>
    const text = (value: unknown, max = 128): value is string =>
      typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
    if (
      text(controls.directory, 1024) &&
      text(controls.providerID) &&
      Array.isArray(controls.models) &&
      controls.models.length <= 512 &&
      Array.isArray(controls.agents) &&
      controls.agents.length <= 64
    ) {
      result.controls = {
        directory: controls.directory,
        providerID: controls.providerID,
        models: controls.models.flatMap((value: unknown) => {
          if (!value || typeof value !== "object") return []
          const model = value as Record<string, unknown>
          if (
            !text(model.id) ||
            !text(model.name) ||
            !Array.isArray(model.variants) ||
            model.variants.length > 32 ||
            !model.variants.every((value) => text(value))
          )
            return []
          return [
            {
              id: model.id,
              name: model.name,
              variants: model.variants as string[],
              ...(text(model.variant) && model.variants.includes(model.variant) ? { variant: model.variant } : {}),
              ...(text(model.releaseDate) ? { releaseDate: model.releaseDate } : {}),
              ...(typeof model.free === "boolean" ? { free: model.free } : {}),
              ...(typeof model.disabled === "boolean" ? { disabled: model.disabled } : {}),
              ...(typeof model.deprecated === "boolean" ? { deprecated: model.deprecated } : {}),
            },
          ]
        }),
        agents: controls.agents.flatMap((value: unknown) => {
          if (!value || typeof value !== "object") return []
          const agent = value as Record<string, unknown>
          if (
            !text(agent.id) ||
            !text(agent.label) ||
            typeof agent.color !== "string" ||
            !/^#[\da-f]{6}$/i.test(agent.color)
          )
            return []
          return [
            {
              id: agent.id,
              label: agent.label,
              color: agent.color,
              ...(text(agent.modelID) ? { modelID: agent.modelID } : {}),
            },
          ]
        }),
      }
    }
  }
  return result
}

export function startupSelectionLabel(selection?: StartupSelection, auto = false) {
  if (!selection) return "Type now · starting"
  return `${selection.agent}${auto ? " auto" : ""} · ${selection.model} ${selection.provider} · ${selection.variant}`
}

// The same semantic spans are used by the raw ANSI frame and Solid preview.
// Match Prompt's stable styles rather than caching transient animation colors.
export function startupSelectionSegments(
  theme: StartupPresentation,
  auto = false,
): { text: string; color: string; bold: boolean; target?: StartupControlTarget | "provider" }[] {
  const selection = theme.selection
  if (!selection) return [{ text: "Type now · starting", color: theme.textMuted, bold: false }]
  return [
    { text: selection.agent, color: selection.agentColor ?? theme.border, bold: false, target: "agent" },
    ...(auto ? [{ text: " auto", color: theme.textMuted, bold: false }] : []),
    { text: " · ", color: theme.textMuted, bold: false },
    { text: selection.model, color: theme.text, bold: false, target: "model" },
    { text: " ", color: theme.textMuted, bold: false },
    { text: selection.provider, color: theme.textMuted, bold: false, target: "provider" },
    { text: " · ", color: theme.textMuted, bold: false },
    { text: selection.variant, color: selection.variantColor ?? theme.warning, bold: true, target: "variant" },
  ]
}

export function homePromptWidth(columns: number, maxWidth: number | "auto" = 75) {
  return Math.max(1, Math.min(columns - 4, maxWidth === "auto" ? Math.max(75, Math.floor(columns * 0.7)) : maxWidth))
}

export function homeInputHeight(rows: number, maxHeight = 0) {
  return maxHeight || Math.max(6, Math.floor(rows / 3))
}

// Yoga's centered home column: two equal flexible spacers, 4 rows above
// the logo, 1 below it, prompt padding + input + metadata/footer, then tips.
export function homeGeometry(
  columns: number,
  rows: number,
  width: number,
  inputHeight: number,
  bottom = 4,
  footer = 3,
) {
  const available = Math.max(0, rows - footer)
  const fixed = 4 + 1 + inputHeight + 5
  const flexible = 5 + bottom
  const free = available - fixed - flexible
  const shrink = Math.min(1, Math.max(0, -free / 5))
  const top = Math.max(0, free / 2) + 4 * (1 - shrink)
  const prompt = top + 4 + (1 - shrink) + 1
  return {
    left: Math.round((columns - width) / 2),
    logoTop: Math.round(top),
    promptTop: Math.round(prompt),
    textTop: Math.round(prompt + 1),
  }
}

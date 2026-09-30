export type StartupSlash = {
  display: string
  description?: string
  aliases?: string[]
  value?: string
  command?: string
}

export type StartupSlashDraft = {
  text: string
  cursor: number
  paste?: boolean
  slash?: { query: string; selected: string; top?: number }
  command?: { name: string; display: string; prefix: string }
  changes?: StartupSelectionChange[]
  submit?: boolean
}

// Cold-start defaults contain only always-available home commands. Subsequent
// launches use the actual reachable registry, including plugin/server commands.
export function builtinStartupSlashes(): StartupSlash[] {
  return [
    { display: "/agents", description: "Switch agent", command: "agent.list" },
    { display: "/connect", description: "Connect provider", command: "provider.connect" },
    { display: "/debug", description: "View debug info", command: "opencode.debug" },
    { display: "/exit", description: "Exit the app", aliases: ["/quit", "/q"], command: "app.exit" },
    { display: "/help", description: "Help", command: "help.show" },
    { display: "/mcp", description: "Manage MCP servers", aliases: ["/mcps"], command: "mcp.list" },
    { display: "/models", description: "Switch model", aliases: ["/mo", "/model"], command: "model.list" },
    { display: "/new", description: "New session", aliases: ["/clear"], command: "session.new" },
    { display: "/remind", description: "Schedule a reminder", command: "reminder.create" },
    { display: "/reminders", description: "Manage reminders", aliases: ["/notifications"], command: "reminder.list" },
    { display: "/sessions", description: "Switch session", aliases: ["/resume", "/continue"], command: "session.list" },
    { display: "/status", description: "View status", command: "opencode.status" },
    { display: "/themes", description: "Switch theme", command: "theme.switch" },
    { display: "/usage", description: "View usage stats", command: "opencode.usage" },
  ]
}

// Serialized into the first-input worker. Keep all runtime logic self-contained.
export function createStartupSlashes(items: StartupSlash[]) {
  let sorted: StartupSlash[] | undefined
  let padding = 0
  const score = (value: string, query: string) => {
    const text = value.toLowerCase()
    const target = query.toLowerCase()
    if (text.startsWith(target)) return 1000 - text.length
    const at = text.indexOf(target)
    if (at >= 0) return 500 - at - text.length
    let position = 0
    let gaps = 0
    for (const char of target) {
      const next = text.indexOf(char, position)
      if (next < 0) return 0
      gaps += next - position
      position = next + 1
    }
    return 100 / (1 + gaps + text.length / 100)
  }
  const view = (state: StartupSlashDraft, available = 10) => {
    if (state.command && !state.text.startsWith(state.command.prefix)) delete state.command
    if (state.paste || !state.text.startsWith("/") || state.cursor === 0 || /\s/.test(state.text)) {
      delete state.slash
      return
    }
    const query = state.text.slice(1, state.cursor)
    if (!sorted) {
      sorted = items.toSorted((a, b) => a.display.localeCompare(b.display))
      padding = Math.max(0, ...sorted.map((item) => Bun.stringWidth(item.display))) + 2
    }
    const options = (
      query
        ? sorted
            .map((item) => ({
              item,
              score: Math.max(
                score(item.display.replace(/^\//, ""), query),
                item.aliases?.length ? score(item.aliases.join(" "), query) : 0,
                ...(item.aliases?.map((alias) => score(alias.replace(/^\//, ""), query)) ?? []),
                item.description ? score(item.description, query) / 2 : 0,
              ),
            }))
            .filter((item) => item.score > 0)
            .toSorted((a, b) => b.score - a.score)
            .slice(0, 10)
            .map((item) => item.item)
        : sorted
    ).map((item) => ({
      ...item,
      display: item.display + " ".repeat(Math.max(0, padding - Bun.stringWidth(item.display))),
    }))
    if (state.slash?.query !== query) state.slash = { query, selected: options[0]?.display.trimEnd() ?? "" }
    const selected = Math.max(
      0,
      options.findIndex((item) => item.display.trimEnd() === state.slash?.selected),
    )
    const height = Math.min(10, options.length || 1, Math.max(1, available))
    const top = Math.max(
      0,
      Math.min(state.slash?.top ?? 0, selected, Math.max(0, options.length - height)),
      selected - height + 1,
    )
    if (state.slash) state.slash.top = top
    return { options, selected, top, height }
  }
  const select = (state: StartupSlashDraft, index: number) => {
    const option = view(state)?.options[index]
    if (!option) return
    const display = (option.value ?? option.display).trimEnd()
    const prefix = display + " "
    state.text = prefix + state.text.slice(state.cursor)
    state.cursor = prefix.length
    delete state.slash
    state.command = option.command ? { name: option.command, display: option.display.trimEnd(), prefix } : undefined
  }
  return {
    view,
    select,
    key(value: string, state: StartupSlashDraft) {
      const menu = view(state)
      if (value === "\x1b" && state.command) {
        const prefix = state.command.prefix.length
        state.text = state.text.slice(prefix)
        state.cursor = Math.max(0, state.cursor - prefix)
        delete state.command
        return true
      }
      if (!menu) return false
      if (["\x1b[A", "\x1bOA", "\x10", "\x1b[B", "\x1bOB", "\x0e"].includes(value)) {
        const direction = ["\x1b[A", "\x1bOA", "\x10"].includes(value) ? -1 : 1
        const index = (menu.selected + direction + menu.options.length) % menu.options.length
        if (state.slash) state.slash.selected = menu.options[index]?.display.trimEnd() ?? ""
        return true
      }
      if (value === "\r" || value === "\n" || value === "\t") {
        select(state, menu.selected)
        return true
      }
      if (value === "\x1b") {
        state.text = state.text.slice(state.cursor)
        state.cursor = 0
        delete state.slash
        return true
      }
      return false
    },
  }
}

export type StartupSlashMenu = ReturnType<ReturnType<typeof createStartupSlashes>["view"]>
import type { StartupSelectionChange } from "./controls"

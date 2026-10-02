import { herdr } from "./herdr"
import { isRecord } from "./record"

export type HerdrScope = "tab" | "workspace" | "all"

export function parseHerdrCommand(text: string): { scope?: HerdrScope; error?: string } | undefined {
  const match = /^\/herdr(?:\s+(.*))?$/s.exec(text.trim())
  if (!match) return undefined
  const scope = match[1]?.trim()
  if (!scope) return { scope: undefined, error: undefined }
  if (scope !== "tab" && scope !== "workspace" && scope !== "all") {
    return { scope: undefined, error: "Usage: /herdr [tab|workspace|all]" }
  }
  return { scope, error: undefined }
}

export async function gatherHerdrSessions(scope: HerdrScope, sessionID?: string) {
  if (process.env.HERDR_ENV !== "1") throw new Error("/herdr requires a Herdr pane")
  if (!Bun.which("herdr")) throw new Error("Herdr is not available in PATH")

  // Resolve inherited caller context through Herdr so moved panes and unfocused tabs work.
  const [current, panes, tabs, workspaces] = await Promise.all([
    herdr(["pane", "current", "--current"]).then(result),
    herdr(["pane", "list"]).then(result),
    herdr(["tab", "list"]).then(result),
    herdr(["workspace", "list"]).then(result),
  ])
  if (!isRecord(current.pane)) throw new Error("Herdr did not return the current pane")
  const caller = pane(current.pane)
  const selected = records(panes.panes)
    .map(pane)
    .filter((item) =>
      scope === "all" ? true : scope === "tab" ? item.tab === caller.tab : item.workspace === caller.workspace,
    )
  const agents = selected.filter((item) => item.agent === "opencode" || item.sessionAgent === "opencode")
  const workspaceNames = new Map(
    records(workspaces.workspaces).map((item) => [field(item, "workspace_id"), field(item, "label")]),
  )
  const tabNames = new Map(records(tabs.tabs).map((item) => [field(item, "tab_id"), field(item, "label")]))
  const counts = agents.reduce(
    (counts, item) => counts.set(item.status, (counts.get(item.status) ?? 0) + 1),
    new Map<string, number>(),
  )
  const label =
    scope === "all"
      ? "all workspaces"
      : scope === "tab"
        ? `tab ${JSON.stringify(tabNames.get(caller.tab) ?? caller.tab)}`
        : `workspace ${JSON.stringify(workspaceNames.get(caller.workspace) ?? caller.workspace)}`
  const text = [
    `Herdr sessions — ${label} — captured ${new Date().toISOString()}`,
    `${agents.length} OpenCode panes · ${agents.filter((item) => item.session).length} reported sessions · ${selected.length} total panes`,
    [...counts].map(([status, count]) => `${count} ${status}`).join(", "),
    "Status is Herdr-reported; done means idle after unseen background work. This is a metadata snapshot, not conversation history.",
    ...[...new Set(agents.map((item) => item.workspace))].flatMap((workspace) => [
      "",
      `Workspace ${JSON.stringify(workspaceNames.get(workspace) ?? workspace)} (${workspace})`,
      ...[...new Set(agents.filter((item) => item.workspace === workspace).map((item) => item.tab))].flatMap((tab) => [
        `  Tab ${JSON.stringify(tabNames.get(tab) ?? tab)} (${tab})`,
        ...agents
          .filter((item) => item.workspace === workspace && item.tab === tab)
          .flatMap((item) => [
            `    ${item.id} · ${item.status}${item.id === caller.id ? " · this pane" : ""}${item.session && item.session === sessionID ? " · this session" : ""}${item.focused ? " · focused pane" : ""}`,
            `      Session: ${item.session || "not reported"}`,
            `      Title: ${JSON.stringify(item.title || "not reported")}`,
            `      Directory: ${JSON.stringify(item.directory || "not reported")}`,
          ]),
      ]),
    ]),
    ...(agents.length ? [] : ["No OpenCode panes found in this scope."]),
  ].join("\n")
  return { text, count: agents.length, scope }
}

function result(text: string) {
  const data: unknown = JSON.parse(text)
  if (!isRecord(data) || !isRecord(data.result)) throw new Error("Invalid Herdr response")
  return data.result
}

function records(value: unknown) {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error("Invalid Herdr inventory")
  return value
}

function field(item: Record<string, unknown>, key: string) {
  return typeof item[key] === "string" ? item[key] : ""
}

function pane(item: Record<string, unknown>) {
  const id = field(item, "pane_id")
  const tab = field(item, "tab_id")
  const workspace = field(item, "workspace_id")
  if (!id || !tab || !workspace) throw new Error("Invalid Herdr pane identity")
  return {
    id,
    tab,
    workspace,
    agent: field(item, "agent"),
    sessionAgent: isRecord(item.agent_session) ? field(item.agent_session, "agent") : "",
    session: isRecord(item.agent_session) && item.agent_session.kind === "id" ? field(item.agent_session, "value") : "",
    status: field(item, "agent_status") || "unknown",
    title: (field(item, "terminal_title_stripped") || field(item, "terminal_title")).replace(/^OC\s*\|\s*/, ""),
    directory: field(item, "foreground_cwd") || field(item, "cwd"),
    focused: item.focused === true,
  }
}

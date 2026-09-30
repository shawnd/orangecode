import { InputRenderable, RGBA, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import type { PermissionRule } from "@opencode-ai/sdk/v2"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { useEvent } from "../context/event"
import { useLocal } from "../context/local"
import { useProject } from "../context/project"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { selectedForeground, useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { orderedPermissionRules, permissionActionPatch } from "./permission-rules"

export function DialogPermissions() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const project = useProject()
  const route = useRoute()
  const event = useEvent()
  const dimensions = useTerminalDimensions()
  const { theme, mode } = useTheme()
  const toast = useToast()
  const session = createMemo(() => (route.data.type === "session" ? sync.session.get(route.data.sessionID) : undefined))
  const scope = createMemo(() => ({
    directory: session()?.directory ?? sync.path.directory,
    workspace: session()?.workspaceID ?? project.workspace.current(),
  }))
  const [status, { refetch }] = createResource(scope, async (scope) => {
    const [status, global, config] = await Promise.all([
      sdk.client.permission.status(scope, { throwOnError: true }),
      sdk.client.global.config.get({ throwOnError: true }),
      sdk.client.config.get(scope, { throwOnError: true }),
    ])
    return {
      ...status.data,
      global: orderedPermissionRules(global.data.permission, status.data.global, sync.path.home),
      configured: orderedPermissionRules(config.data.permission, status.data.configured, sync.path.home),
    }
  })
  const refresh = () => {
    void Promise.resolve(refetch()).catch(() => {})
  }
  onCleanup(
    event.subscribe((evt) => {
      if (
        evt.type === "permission.asked" ||
        evt.type === "permission.replied" ||
        evt.type === "server.instance.disposed"
      )
        refresh()
    }),
  )

  const [tab, setTab] = createSignal("Config")
  const [query, setQuery] = createSignal("")
  const [cursor, setCursor] = createSignal(0)
  const [editing, setEditing] = createSignal<{ scope: "Config" | "Global"; rule: PermissionRule }>()
  const [action, setAction] = createSignal<PermissionRule["action"]>("ask")
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal("")
  const actions = ["allow", "ask", "deny"] as const
  // Permission states use a legend, so allow must stay green even in monochrome themes.
  const allowColor = createMemo(() => RGBA.fromHex(mode() === "dark" ? "#4ade80" : "#15803d"))
  const color = (action: PermissionRule["action"]) =>
    action === "allow" ? allowColor() : action === "deny" ? theme.error : theme.warning
  const narrow = () => dimensions().width < 78
  const pending = createMemo(() => (status.error ? [] : (status()?.pending ?? [])))
  const sections = createMemo(() => {
    const value = status.error ? undefined : status()
    return [
      {
        label: "Config",
        title: "Config · directory overrides",
        description: "Edits save directory overrides. Last match wins; agent/session rules also apply.",
        empty: "No permission rules in this directory's configuration.",
        rules: value?.configured ?? [],
      },
      {
        label: "Global",
        title: "Global rules",
        description: "Edits save to global config. Project and agent rules may override them.",
        empty: "No global permission rules configured.",
        rules: value?.global ?? [],
      },
      {
        label: "Agent",
        title: `Agent: ${local.agent.current()?.name ?? "none"}`,
        description: "Read-only agent defaults and overrides. Last matching rule wins.",
        empty: "No rules for the selected agent.",
        rules: local.agent.current()?.permission ?? [],
      },
      {
        label: "Session",
        title: "Session rules",
        description: "Read-only overrides attached to this session.",
        empty: session() ? "No session-specific overrides." : "Open a session to see its permission overrides.",
        rules: session()?.permission ?? [],
      },
      {
        label: "Active",
        title: "Temporary approvals",
        description: 'Read-only "always" approvals. Cleared on restart/reload; configured denies still apply.',
        empty: "No temporary approvals. Check Config and Agent for saved rules and defaults.",
        rules: value?.approved ?? [],
      },
      {
        label: "Pending",
        title: "Pending requests",
        description: "Requests awaiting a response in this instance. Respond from the requesting session.",
        empty: "No requests waiting for approval.",
        rules: [],
      },
    ]
  })
  const tabs = createMemo(() => (narrow() ? [sections().slice(0, 3), sections().slice(3)] : [sections()]))
  const selected = createMemo(() => sections().find((section) => section.label === tab()) ?? sections()[0])
  const needle = createMemo(() => query().trim().toLowerCase())
  const rules = createMemo(() =>
    selected()
      .rules.map((rule, index) => ({ ...rule, index }))
      .filter((rule) => `${rule.action} ${rule.permission} ${rule.pattern}`.toLowerCase().includes(needle())),
  )
  const requests = createMemo(() =>
    pending().filter((request) =>
      `ask ${request.permission} ${request.patterns.join(" ")} ${request.sessionID} ${sync.session.get(request.sessionID)?.title ?? ""}`
        .toLowerCase()
        .includes(needle()),
    ),
  )
  const total = () => (tab() === "Pending" ? pending().length : selected().rules.length)
  const count = () => (tab() === "Pending" ? requests().length : rules().length)
  createEffect(() => {
    if (cursor() >= rules().length) setCursor(Math.max(0, rules().length - 1))
  })
  let input: InputRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined
  let editorScroll: ScrollBoxRenderable | undefined
  const editable = () => tab() === "Global" || tab() === "Config"
  const edit = (rule = rules()[cursor()]) => {
    const label = tab()
    if (!rule || (label !== "Global" && label !== "Config") || saving()) return
    setError("")
    setAction(rule.action)
    setEditing({ scope: label, rule })
    input?.blur()
  }
  const back = () => {
    if (saving()) return
    setEditing(undefined)
    setError("")
    input?.focus()
  }
  const toggle = () => local.permission.toggle()
  const save = async (next: PermissionRule["action"]) => {
    const target = editing()
    if (!target || saving()) return
    setSaving(true)
    setError("")
    const progress = { saved: false }
    const location = scope()
    const operation = async () => {
      const fresh =
        target.scope === "Global"
          ? await sdk.client.global.config.get({ throwOnError: true })
          : await sdk.client.config.get(location, { throwOnError: true })
      const config = permissionActionPatch(fresh.data.permission, target.rule, next)
      if (target.scope === "Global") await sdk.client.global.config.update({ config }, { throwOnError: true })
      if (target.scope === "Config") await sdk.client.config.update({ ...location, config }, { throwOnError: true })
      progress.saved = true
      const [updated, agents, status] = await Promise.all([
        sdk.client.config.get(location, { throwOnError: true }),
        sdk.client.app.agents(location, { throwOnError: true }),
        refetch(),
      ])
      sync.set("config", updated.data)
      sync.set("agent", agents.data)
      const rules = target.scope === "Global" ? status?.global : status?.configured
      const current = rules?.find(
        (rule) => rule.permission === target.rule.permission && rule.pattern === target.rule.pattern,
      )
      toast.show({
        variant: current?.action === next ? "success" : "warning",
        message:
          current?.action === next
            ? `Saved ${target.scope === "Global" ? "global rule" : "directory override"}: ${target.rule.permission} → ${next}`
            : "Saved, but a higher-priority config overrides this action.",
      })
      setEditing(undefined)
      input?.focus()
    }
    await operation().catch((error) =>
      setError(
        `${progress.saved ? "Saved, but refresh failed. " : ""}${error instanceof Error ? error.message : "Request failed. Refresh and retry."}`,
      ),
    )
    setSaving(false)
  }
  const moveRule = (direction: number) => {
    if (!rules().length) return scroll?.scrollBy(direction)
    const next = Math.max(0, Math.min(rules().length - 1, cursor() + direction))
    setCursor(next)
    scroll?.scrollChildIntoView(`permission-rule-${next}`)
  }
  const clear = () => {
    input?.setText("")
    setQuery("")
    setCursor(0)
    scroll?.scrollTo(0)
  }
  const select = (label: string) => {
    if (editing()) return
    setTab(label)
    setCursor(0)
    scroll?.scrollTo(0)
  }
  const move = (direction: number) => {
    const index = sections().findIndex((section) => section.label === tab())
    select(sections()[(index + direction + sections().length) % sections().length].label)
  }
  useBindings(() => ({
    bindings: editing()
      ? [
          {
            key: "left",
            desc: "Previous action",
            group: "Permissions",
            cmd: () => setAction(actions[(actions.indexOf(action()) + 2) % 3]),
          },
          {
            key: "right",
            desc: "Next action",
            group: "Permissions",
            cmd: () => setAction(actions[(actions.indexOf(action()) + 1) % 3]),
          },
          { key: "return", desc: "Save action", group: "Permissions", cmd: () => void save(action()) },
          { key: "backspace", desc: "Back to rules", group: "Permissions", cmd: back },
          { key: "up", desc: "Scroll details up", group: "Permissions", cmd: () => editorScroll?.scrollBy(-1) },
          { key: "down", desc: "Scroll details down", group: "Permissions", cmd: () => editorScroll?.scrollBy(1) },
        ]
      : [
          { key: "tab", desc: "Next section", group: "Permissions", cmd: () => move(1) },
          { key: "shift+tab", desc: "Previous section", group: "Permissions", cmd: () => move(-1) },
          { key: "up", desc: "Previous rule", group: "Permissions", cmd: () => moveRule(-1) },
          { key: "down", desc: "Next rule", group: "Permissions", cmd: () => moveRule(1) },
          { key: "return", desc: "Edit action", group: "Permissions", cmd: () => edit() },
          { key: "ctrl+t", desc: "Toggle auto-approve (this TUI)", group: "Permissions", cmd: toggle },
          { key: "pageup", desc: "Page up", group: "Permissions", cmd: () => scroll?.scrollBy(-1, "viewport") },
          { key: "pagedown", desc: "Page down", group: "Permissions", cmd: () => scroll?.scrollBy(1, "viewport") },
          { key: "ctrl+r", desc: "Refresh permissions", group: "Permissions", cmd: refresh },
          { key: "ctrl+u", desc: "Clear filter", group: "Permissions", cmd: clear },
        ],
  }))
  dialog.setSize("large")

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Permissions
        </text>
        <box flexDirection="row" gap={2}>
          <text fg={theme.text} onMouseUp={toggle}>
            <span style={{ fg: local.permission.mode === "auto" ? theme.warning : theme.textMuted }}>●</span> Auto{" "}
            {local.permission.mode === "auto" ? "on" : "off"}
          </text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </box>
      </box>
      <box marginBottom={narrow() ? 0 : 1}>
        <For each={tabs()}>
          {(row) => (
            <box flexDirection="row" gap={1}>
              <For each={row}>
                {(section) => (
                  <box
                    flexGrow={1}
                    flexBasis={0}
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={tab() === section.label ? theme.primary : theme.backgroundElement}
                    onMouseUp={() => select(section.label)}
                  >
                    <text
                      fg={
                        tab() === section.label
                          ? selectedForeground(theme)
                          : section.label === "Pending" && pending().length
                            ? theme.warning
                            : theme.textMuted
                      }
                      attributes={tab() === section.label ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                    >
                      {section.label} {section.label === "Pending" ? pending().length : section.rules.length}
                    </text>
                  </box>
                )}
              </For>
            </box>
          )}
        </For>
      </box>
      <box visible={!editing()} flexDirection="row" gap={1} marginBottom={narrow() ? 0 : 1}>
        <text fg={theme.primary}>/</text>
        <input
          flexGrow={1}
          minWidth={0}
          placeholder="Filter tool, pattern or action…"
          placeholderColor={theme.textMuted}
          focusedBackgroundColor={theme.backgroundPanel}
          focusedTextColor={theme.text}
          cursorColor={theme.primary}
          ref={(value) => {
            input = value
            setTimeout(() => {
              if (!value.isDestroyed) value.focus()
            }, 1)
          }}
          onInput={(value) => {
            setQuery(value)
            setCursor(0)
            scroll?.scrollTo(0)
          }}
        />
        <Show when={query()}>
          <text fg={theme.textMuted} onMouseUp={clear}>
            ctrl+u clear
          </text>
        </Show>
      </box>
      <Show when={editing()}>
        {(target) => (
          <box gap={1}>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {target().scope === "Global" ? "Edit global rule" : "Save directory override"}
            </text>
            <scrollbox
              ref={(value) => {
                editorScroll = value
              }}
              maxHeight={Math.max(3, Math.floor(dimensions().height * 0.75) - 14)}
              contentOptions={{ minHeight: 0 }}
            >
              <text fg={theme.text} wrapMode="word">
                {target().rule.permission} · {target().rule.pattern}
              </text>
              <text fg={theme.textMuted} wrapMode="word">
                {target().scope === "Global"
                  ? "Persists across projects. Other scopes may override it."
                  : "Writes this directory's config, not the inherited source."}
              </text>
              <Show when={error()}>
                <text fg={theme.error} wrapMode="word">
                  {error()}
                </text>
              </Show>
            </scrollbox>
            <box flexDirection="row" gap={2}>
              <For each={actions}>
                {(item) => (
                  <text
                    fg={theme.text}
                    attributes={action() === item ? TextAttributes.BOLD | TextAttributes.UNDERLINE : undefined}
                    onMouseUp={() => void save(item)}
                  >
                    {action() === item ? "› " : "  "}
                    <span style={{ fg: color(item) }}>●</span> {item}
                  </text>
                )}
              </For>
            </box>
            <text fg={theme.textMuted} onMouseUp={back}>
              {saving() ? "Saving…" : "← backspace back · ← → choose · enter save"}
            </text>
          </box>
        )}
      </Show>
      <Show
        when={!status.error}
        fallback={
          <text visible={!editing()} fg={theme.error} wrapMode="word">
            Could not load permissions. Ctrl+r to retry.
          </text>
        }
      >
        <Show when={status()}>
          <box visible={!editing()} flexDirection="row" justifyContent="space-between">
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {selected().title}
            </text>
            <text fg={theme.textMuted}>
              {query().trim() ? `${count()}/${total()}` : total()} {tab() === "Pending" ? "waiting" : "rules"}
            </text>
          </box>
          <scrollbox
            visible={!editing()}
            ref={(value) => {
              scroll = value
            }}
            // The dialog starts a quarter of the way down the terminal.
            maxHeight={Math.max(3, Math.min(24, Math.floor(dimensions().height * 0.75) - 12))}
            contentOptions={{ gap: 1, minHeight: 0 }}
          >
            <text fg={theme.textMuted} wrapMode="word" flexShrink={0}>
              {selected().description}
            </text>
            <Show
              when={count()}
              fallback={
                <text fg={theme.text} paddingLeft={1} paddingRight={1} wrapMode="word" flexShrink={0}>
                  {total() ? "No matches in this scope. Clear the filter or try another tab." : selected().empty}
                </text>
              }
            >
              <Show when={tab() !== "Pending"}>
                <box flexShrink={0}>
                  <For each={rules()}>
                    {(rule, index) => (
                      <box
                        id={`permission-rule-${index()}`}
                        flexShrink={0}
                        flexDirection="row"
                        gap={1}
                        paddingLeft={1}
                        paddingRight={1}
                        backgroundColor={index() % 2 === 0 ? theme.backgroundElement : theme.backgroundPanel}
                      >
                        <text fg={theme.text} width={Math.max(3, String(total()).length + 1)} flexShrink={0}>
                          {cursor() === index() ? "›" : " "}
                          {rule.index + 1}
                        </text>
                        <text width={1} flexShrink={0} attributes={TextAttributes.BOLD} fg={color(rule.action)}>
                          ●
                        </text>
                        <box flexGrow={1} minWidth={0}>
                          <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="word">
                            {rule.permission}
                          </text>
                          <text fg={theme.text} wrapMode="word">
                            {rule.pattern}
                            <span style={{ fg: theme.textMuted }}>{rule.pattern === "*" ? " (all targets)" : ""}</span>
                          </text>
                        </box>
                        <Show when={editable()}>
                          <text fg={theme.textMuted} flexShrink={0} onMouseUp={() => edit(rule)}>
                            edit
                          </text>
                        </Show>
                      </box>
                    )}
                  </For>
                </box>
              </Show>
              <Show when={tab() === "Pending"}>
                <For each={requests()}>
                  {(request) => (
                    <box backgroundColor={theme.backgroundElement} padding={1} gap={1} flexShrink={0}>
                      <text fg={theme.text} wrapMode="word" attributes={TextAttributes.BOLD}>
                        <span style={{ fg: theme.warning }}>● </span>
                        {request.permission}
                      </text>
                      <text fg={theme.textMuted} wrapMode="word">
                        {sync.session.get(request.sessionID)?.title ?? request.sessionID}
                        {request.sessionID === session()?.id ? " (current session)" : ""}
                      </text>
                      <For each={request.patterns}>
                        {(pattern) => (
                          <text fg={theme.text} wrapMode="word">
                            {pattern}
                          </text>
                        )}
                      </For>
                    </box>
                  )}
                </For>
              </Show>
            </Show>
          </scrollbox>
        </Show>
      </Show>
      <Show when={!editing() && status.loading && !status.latest}>
        <text fg={theme.textMuted}>Loading permissions…</text>
      </Show>
      <text fg={theme.textMuted} marginTop={1}>
        <span style={{ fg: color("allow") }}>●</span> Allow <span style={{ fg: color("ask") }}>●</span> Ask{" "}
        <span style={{ fg: color("deny") }}>●</span> Deny
      </text>
      <box visible={!editing()}>
        <text fg={theme.textMuted} wrapMode="word">
          tab scope · ↑↓ select{editable() ? " · enter edit" : " · read-only"}
          {narrow() ? "\n" : " · "}ctrl+t auto (TUI) · ctrl+r {status.loading ? "loading…" : "refresh"}
        </text>
      </box>
    </box>
  )
}

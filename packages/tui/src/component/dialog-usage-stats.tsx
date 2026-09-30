import type { SessionV2Info } from "@opencode-ai/sdk/v2/client"
import { TextAttributes } from "@opentui/core"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useRoute } from "../context/route"
import { useProject } from "../context/project"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { useDialog } from "../ui/dialog"
import { Locale } from "../util/locale"
import { summarizeUsage } from "./usage-stats"

type Scope = "all" | "project" | "session"
type Tokens = SessionV2Info["tokens"]

function total(tokens: Tokens) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

export function DialogUsageStats() {
  const dialog = useDialog()
  const sdk = useSDK()
  const project = useProject()
  const route = useRoute()
  const { theme } = useTheme()
  const [scope, setScope] = createSignal<Scope>(route.data.type === "session" ? "session" : "project")
  const [sessions] = createResource(async () => {
    const result: SessionV2Info[] = []
    let cursor: string | undefined
    for (;;) {
      const response = await sdk.globalClient.v2.session.list(
        { limit: 5000, order: "desc", cursor },
        { throwOnError: true },
      )
      result.push(...response.data.data)
      if (!response.data.cursor.next) return result
      cursor = response.data.cursor.next
    }
  })
  const stats = createMemo(() =>
    summarizeUsage(
      sessions() ?? [],
      project.project(),
      route.data.type === "session" ? route.data.sessionID : undefined,
    ),
  )
  const selected = createMemo(() => stats()[scope()])
  const amounts = createMemo(() => [
    { name: "Input", value: selected().tokens.input },
    { name: "Output", value: selected().tokens.output },
    { name: "Reasoning", value: selected().tokens.reasoning },
    { name: "Cache read", value: selected().tokens.cache.read },
    { name: "Cache write", value: selected().tokens.cache.write },
  ])
  const maxTokens = createMemo(() => Math.max(1, ...amounts().map((item) => item.value)))
  const scopes = [
    { id: "all", label: "All projects" },
    { id: "project", label: "This project" },
    { id: "session", label: "This session" },
  ] as const

  const move = (direction: number) => {
    const index = scopes.findIndex((item) => item.id === scope())
    setScope(scopes[(index + direction + scopes.length) % scopes.length].id)
  }
  useBindings(() => ({
    bindings: [
      { key: "tab", desc: "Next scope", group: "Usage", cmd: () => move(1) },
      { key: "shift+tab", desc: "Previous scope", group: "Usage", cmd: () => move(-1) },
      { key: "right", desc: "Next scope", group: "Usage", cmd: () => move(1) },
      { key: "left", desc: "Previous scope", group: "Usage", cmd: () => move(-1) },
      { key: "down", desc: "Next scope", group: "Usage", cmd: () => move(1) },
      { key: "up", desc: "Previous scope", group: "Usage", cmd: () => move(-1) },
    ],
  }))

  dialog.setSize("medium")

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Usage stats
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
        <For each={scopes}>
          {(item) => (
            <text
              fg={scope() === item.id ? theme.accent : theme.textMuted}
              attributes={scope() === item.id ? TextAttributes.BOLD : undefined}
              onMouseUp={() => setScope(item.id)}
            >
              {item.label}
            </text>
          )}
        </For>
      </box>
      <Show when={sessions.error}>
        <text fg={theme.error}>Could not load usage stats. Reopen to retry.</text>
      </Show>
      <Show when={sessions.loading}>
        <text fg={theme.textMuted}>Loading usage across all sessions…</text>
      </Show>
      <Show when={sessions()}>
        <box gap={1}>
          <box
            flexDirection="row"
            justifyContent="space-between"
            backgroundColor={theme.backgroundElement}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={1}
            paddingBottom={1}
          >
            <box>
              <text fg={theme.textMuted}>Sessions</text>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                {Locale.number(selected().sessions)}
              </text>
            </box>
            <box>
              <text fg={theme.textMuted}>Tokens</text>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                {Locale.number(total(selected().tokens))}
              </text>
            </box>
            <box>
              <text fg={theme.textMuted}>Cost</text>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                ${selected().cost.toFixed(2)}
              </text>
            </box>
          </box>
          <box gap={1} paddingTop={1}>
            <text fg={theme.textMuted}>TOKENS BY TYPE</text>
            <box paddingLeft={1} gap={1}>
              <For each={amounts()}>
                {(item) => (
                  <box flexDirection="row" gap={1}>
                    <text fg={theme.textMuted} width={12}>
                      {item.name}
                    </text>
                    <text fg={theme.accent} wrapMode="none" width={20}>
                      {"█".repeat(item.value ? Math.max(1, Math.round((item.value / maxTokens()) * 20)) : 0)}
                    </text>
                    <text fg={theme.text}>{Locale.number(item.value)}</text>
                  </box>
                )}
              </For>
            </box>
          </box>
          <box gap={1} paddingTop={1}>
            <text fg={theme.textMuted}>COST BY SCOPE</text>
            <box paddingLeft={1} gap={1}>
              <For each={scopes}>
                {(item) => (
                  <box flexDirection="row" gap={1}>
                    <text fg={scope() === item.id ? theme.text : theme.textMuted} width={14}>
                      {item.label}
                    </text>
                    <text fg={theme.secondary} wrapMode="none" width={20}>
                      {"█".repeat(
                        stats()[item.id].cost
                          ? Math.max(1, Math.round((stats()[item.id].cost / stats().all.cost) * 20))
                          : 0,
                      )}
                    </text>
                    <text fg={theme.text}>${stats()[item.id].cost.toFixed(2)}</text>
                  </box>
                )}
              </For>
            </box>
          </box>
        </box>
      </Show>
      <text fg={theme.textMuted}>tab / shift+tab or arrows switch scope</text>
    </box>
  )
}

import type { SessionUsage } from "@opencode-ai/sdk/v2/client"
import { TextAttributes } from "@opentui/core"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useRoute } from "../context/route"
import { useProject } from "../context/project"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { useDialog } from "../ui/dialog"
import { Locale } from "../util/locale"
import { usagePeriods, usageStart, type UsagePeriod } from "./usage-stats"

type Scope = "all" | "project" | "session"
type Tokens = SessionUsage["all"]["tokens"]

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
  const [period, setPeriod] = createSignal<UsagePeriod>("all")
  const [control, setControl] = createSignal<"scope" | "period">("scope")
  const now = Date.now()
  const cache = new Map<string, Promise<SessionUsage>>()
  const [stats] = createResource(
    () => ({
      period: period(),
      project: project.project(),
      session: route.data.type === "session" ? route.data.sessionID : undefined,
    }),
    (input) => {
      const start = usageStart(input.period, now)
      const key = JSON.stringify(input)
      const cached = cache.get(key)
      if (cached) return cached
      const result = (async () => {
        const response = await sdk.globalClient.v2.session.usage(
          { start: start === undefined ? undefined : String(start), project: input.project, session: input.session },
          { throwOnError: true },
        )
        return response.data.data
      })().catch((error: unknown) => {
        cache.delete(key)
        throw error
      })
      cache.set(key, result)
      return result
    },
  )
  const selected = createMemo(
    () =>
      stats()?.[scope()] ?? {
        sessions: 0,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
  )
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
  const movePeriod = (direction: number) => {
    const index = usagePeriods.findIndex((item) => item.id === period())
    setPeriod(usagePeriods[(index + direction + usagePeriods.length) % usagePeriods.length].id)
  }
  const toggleControl = () => setControl((value) => (value === "scope" ? "period" : "scope"))
  useBindings(() => ({
    bindings: [
      { key: "tab", desc: "Switch control", group: "Usage", cmd: toggleControl },
      { key: "shift+tab", desc: "Switch control", group: "Usage", cmd: toggleControl },
      {
        key: "right",
        desc: "Next scope",
        group: "Usage",
        cmd: () => {
          setControl("scope")
          move(1)
        },
      },
      {
        key: "left",
        desc: "Previous scope",
        group: "Usage",
        cmd: () => {
          setControl("scope")
          move(-1)
        },
      },
      {
        key: "down",
        desc: "Next time span",
        group: "Usage",
        cmd: () => {
          setControl("period")
          movePeriod(1)
        },
      },
      {
        key: "up",
        desc: "Previous time span",
        group: "Usage",
        cmd: () => {
          setControl("period")
          movePeriod(-1)
        },
      },
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
        <text fg={control() === "scope" ? theme.accent : theme.textMuted} width={11}>
          Hierarchy
        </text>
        <For each={scopes}>
          {(item) => (
            <text
              fg={scope() === item.id ? theme.accent : theme.textMuted}
              attributes={scope() === item.id ? TextAttributes.BOLD : undefined}
              onMouseUp={() => {
                setControl("scope")
                setScope(item.id)
              }}
            >
              {item.label}
            </text>
          )}
        </For>
      </box>
      <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
        <text fg={control() === "period" ? theme.accent : theme.textMuted} width={11}>
          Time span
        </text>
        <For each={usagePeriods}>
          {(item) => (
            <text
              fg={period() === item.id ? theme.accent : theme.textMuted}
              attributes={period() === item.id ? TextAttributes.BOLD : undefined}
              onMouseUp={() => {
                setControl("period")
                setPeriod(item.id)
              }}
            >
              {item.id === "all" ? "All time" : item.id}
            </text>
          )}
        </For>
      </box>
      <Show when={stats.error}>
        <text fg={theme.error}>Could not load usage stats. Reopen to retry.</text>
      </Show>
      <Show when={stats.loading}>
        <text fg={theme.textMuted}>Loading usage for the selected time span…</text>
      </Show>
      <Show when={stats() && !stats.loading && !stats.error}>
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
                        stats()?.[item.id].cost
                          ? Math.max(1, Math.round(((stats()?.[item.id].cost ?? 0) / (stats()?.all.cost || 1)) * 20))
                          : 0,
                      )}
                    </text>
                    <text fg={theme.text}>${(stats()?.[item.id].cost ?? 0).toFixed(2)}</text>
                  </box>
                )}
              </For>
            </box>
          </box>
        </box>
      </Show>
      <text fg={theme.textMuted}>← → scope · ↑ ↓ time · tab switches control</text>
    </box>
  )
}

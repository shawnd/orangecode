import { createMemo, createSignal } from "solid-js"
import { Schema } from "effect"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { useSync } from "../context/sync"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useSDK } from "../context/sdk"

const AddInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  config: ConfigMCPV1.Info,
  scope: Schema.Literals(["project", "global", "runtime"]),
})

export function DialogMcp() {
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const [loading, setLoading] = createSignal<string>()
  const options = createMemo(() => [
    { value: "", title: "Add MCP server…", description: "local command or remote URL", category: "Manage" },
    ...Object.entries(sync.data.mcp ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, status]) => ({
        value: name,
        title: name,
        description:
          status.status === "failed" || status.status === "needs_client_registration"
            ? `${status.status}: ${status.error}`
            : status.status,
        footer: loading() === name ? "⋯ Working" : status.status === "connected" ? "✓ Connected" : "○ Disconnected",
        category: "Servers",
      })),
  ])

  async function run(name: string, operation: () => Promise<unknown>) {
    if (loading() !== undefined) return
    setLoading(name)
    try {
      await operation()
      const status = await sdk.client.mcp.status({}, { throwOnError: true })
      if (status.data) sync.set("mcp", status.data)
      const result = status.data?.[name]
      if (result?.status === "failed" || result?.status === "needs_client_registration") throw new Error(result.error)
      toast.show({ variant: "info", message: `${name}: ${result?.status ?? "updated"}` })
    } catch (error) {
      toast.show({ variant: "error", message: error instanceof Error ? error.message : JSON.stringify(error) })
    } finally {
      setLoading(undefined)
    }
  }

  function add() {
    dialog.replace(() => (
      <DialogPrompt
        title="Add MCP server (JSON)"
        value={'{"name":"my-server","config":{"type":"remote","url":"https://example.com/mcp"},"scope":"project"}'}
        description={() => (
          <text>
            Use project/global to save, or runtime until restart. Local config:{" "}
            {`{"type":"local","command":["bun","x","server-package"]}`}
          </text>
        )}
        busy={loading() !== undefined}
        onConfirm={async (value) => {
          if (loading() !== undefined) return
          setLoading("")
          try {
            const input = Schema.decodeUnknownSync(Schema.fromJsonString(AddInput))(value)
            await sdk.client.mcp.add(input, { throwOnError: true })
            const status = await sdk.client.mcp.status({}, { throwOnError: true })
            if (status.data) sync.set("mcp", status.data)
            toast.show({ variant: "info", message: `${input.name}: ${status.data?.[input.name]?.status ?? "added"}` })
            dialog.replace(() => <DialogMcp />)
          } catch (error) {
            toast.show({ variant: "error", message: error instanceof Error ? error.message : JSON.stringify(error) })
          } finally {
            setLoading(undefined)
          }
        }}
      />
    ))
  }

  function manage(name: string) {
    dialog.replace(() => (
      <DialogSelect
        title={loading() === name ? `MCP: ${name} — working…` : `MCP: ${name}`}
        locked={loading() !== undefined}
        options={[
          {
            value: "connect",
            title: "Connect / retry",
            onSelect: () => void run(name, () => sdk.client.mcp.connect({ name }, { throwOnError: true })),
          },
          {
            value: "disconnect",
            title: "Disconnect",
            onSelect: () => void run(name, () => sdk.client.mcp.disconnect({ name }, { throwOnError: true })),
          },
          {
            value: "reconnect",
            title: "Reconnect / restart",
            onSelect: () =>
              void run(name, async () => {
                await sdk.client.mcp.disconnect({ name }, { throwOnError: true })
                await sdk.client.mcp.connect({ name }, { throwOnError: true })
              }),
          },
          {
            value: "auth",
            title: "Authenticate (OAuth)",
            description: "opens browser and waits for authorization",
            onSelect: () => void run(name, () => sdk.client.mcp.auth.authenticate({ name }, { throwOnError: true })),
          },
          {
            value: "logout",
            title: "Log out / clear credentials",
            onSelect: () =>
              void run(name, async () => {
                await sdk.client.mcp.disconnect({ name }, { throwOnError: true })
                await sdk.client.mcp.auth.remove({ name }, { throwOnError: true })
              }),
          },
          { value: "back", title: "Back to servers", onSelect: () => dialog.replace(() => <DialogMcp />) },
        ]}
      />
    ))
  }

  return (
    <DialogSelect
      title="MCP servers"
      options={options()}
      actions={[
        {
          command: "dialog.mcp.toggle",
          title: "toggle",
          disabled: (option) => !option?.value || loading() !== undefined,
          onTrigger: (option) =>
            void run(option.value, () =>
              sync.data.mcp[option.value]?.status === "connected"
                ? sdk.client.mcp.disconnect({ name: option.value }, { throwOnError: true })
                : sdk.client.mcp.connect({ name: option.value }, { throwOnError: true }),
            ),
        },
      ]}
      onSelect={(option) => (option.value ? manage(option.value) : void add())}
    />
  )
}

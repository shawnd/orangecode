import { Effect, Schema } from "effect"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { MCP } from "@/mcp"
import { EffectBridge } from "@/effect/bridge"
import { Tool } from "./tool"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

const Name = Schema.Struct({
  name: Schema.String.annotate({ description: "Exact MCP server name from mcp_list" }),
})
const Scope = Schema.Literals(["project", "global", "runtime"])
const Add = Schema.Struct({
  name: Schema.String,
  config: ConfigMCPV1.Info.annotate({
    description: "Complete local or remote server configuration. Replaces the selected scope's entry.",
  }),
  scope: Schema.optional(Scope).annotate({
    description: "project (default) or global persists across restarts; runtime applies only to this running instance",
  }),
})
const Remove = Schema.Struct({
  name: Schema.String,
  scope: Schema.optional(Scope).annotate({
    description: "Remove from project (default), global, or runtime configuration",
  }),
})

export const McpManagementTools = Effect.gen(function* () {
  const mcp = yield* MCP.Service
  const named = (
    id: string,
    description: string,
    run: (name: string, ctx: Tool.Context) => Effect.Effect<unknown, MCP.NotFoundError>,
  ) =>
    Tool.define(
      id,
      Effect.succeed({
        description,
        parameters: Name,
        execute: (params: typeof Name.Type, ctx: Tool.Context) =>
          Effect.gen(function* () {
            yield* ctx.ask({ permission: id, patterns: [params.name], always: ["*"], metadata: { name: params.name } })
            const result = yield* run(params.name, ctx)
            return {
              title: `${id}: ${params.name}`,
              output: JSON.stringify(result, null, 2),
              metadata: { name: params.name },
            }
          }).pipe(Effect.orDie),
      }),
    )

  const list = yield* Tool.define(
    "mcp_list",
    Effect.succeed({
      description:
        "List configured MCP servers, connection errors, OAuth status, and available tool names. Use before managing servers. Credential values are omitted.",
      parameters: Schema.Struct({}),
      execute: () =>
        Effect.gen(function* () {
          const statuses = yield* mcp.status()
          const tools = yield* mcp.tools()
          const clients = yield* mcp.clients()
          const servers = yield* Effect.forEach(
            Object.entries(yield* mcp.configured()),
            ([name, config]) =>
              Effect.gen(function* () {
                return {
                  name,
                  type: config.type,
                  status: statuses[name],
                  enabledOnStartup: config.enabled !== false,
                  ...(config.type === "local"
                    ? {
                        command: config.command,
                        cwd: config.cwd,
                        environmentKeys: Object.keys(config.environment ?? {}),
                      }
                    : {
                        url: config.url,
                        headerNames: Object.keys(config.headers ?? {}),
                        oauth: config.oauth !== false,
                        authStatus: yield* mcp.getAuthStatus(name),
                      }),
                  tools: Object.entries(tools)
                    .filter(([, tool]) => tool.client === clients[name])
                    .map(([id]) => id),
                }
              }),
            { concurrency: "unbounded" },
          )
          return { title: "MCP servers", output: JSON.stringify(servers, null, 2), metadata: {} }
        }),
    }),
  )

  const add = yield* Tool.define(
    "mcp_add",
    Effect.succeed({
      description:
        "Add or replace an MCP server and apply it immediately. Supports local commands, cwd, environment; remote URLs, headers, OAuth client settings; enabled and timeout. Choose project/global persistence or runtime-only. Newly connected tools become available on the next provider turn.",
      parameters: Add,
      execute: (params: typeof Add.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "mcp_add",
            patterns: [params.name],
            always: ["*"],
            metadata: { name: params.name, scope: params.scope ?? "project", type: params.config.type },
          })
          const result = yield* mcp.configure(params.name, params.config, params.scope ?? "project")
          return {
            title: `Configure MCP: ${params.name}`,
            output: JSON.stringify(result, null, 2),
            metadata: { name: params.name },
          }
        }).pipe(Effect.orDie),
    }),
  )

  const remove = yield* Tool.define(
    "mcp_remove",
    Effect.succeed({
      description:
        "Remove an MCP server from the selected config scope, close its active connection, and clear OAuth credentials. Removing an override may reveal an inherited config entry, which stays disconnected in this instance. Use mcp_disconnect to temporarily stop a server without deleting config or credentials.",
      parameters: Remove,
      execute: (params: typeof Remove.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "mcp_remove",
            patterns: [params.name],
            always: ["*"],
            metadata: { name: params.name, scope: params.scope ?? "project" },
          })
          const result = yield* mcp.remove(params.name, params.scope ?? "project")
          return {
            title: `Remove MCP: ${params.name}`,
            output: JSON.stringify({ ...result, statuses: yield* mcp.status() }, null, 2),
            metadata: { name: params.name },
          }
        }).pipe(Effect.orDie),
    }),
  )

  const connect = yield* named(
    "mcp_connect",
    "Connect or retry a configured MCP server immediately, including disabled servers. Does not change startup configuration. Returns connection status and errors.",
    (name) =>
      mcp.connect(name).pipe(
        Effect.andThen(mcp.status()),
        Effect.map((statuses) => statuses[name]),
      ),
  )
  const disconnect = yield* named(
    "mcp_disconnect",
    "Disconnect an MCP server for this running instance. Keeps configuration and OAuth credentials. Its tools are removed from subsequent provider turns.",
    (name) =>
      mcp.disconnect(name).pipe(
        Effect.andThen(mcp.status()),
        Effect.map((statuses) => statuses[name]),
      ),
  )
  const reconnect = yield* named(
    "mcp_reconnect",
    "Close and reconnect an MCP server to restart a local process or refresh a remote connection and tool catalog. Keeps stored credentials.",
    (name) =>
      mcp.disconnect(name).pipe(
        Effect.andThen(mcp.connect(name)),
        Effect.andThen(mcp.status()),
        Effect.map((statuses) => statuses[name]),
      ),
  )
  const auth = yield* named(
    "mcp_auth",
    "Authenticate an OAuth-capable remote MCP server. Opens the user's browser and waits for authorization, then connects the server. The user must complete login/consent; the agent can initiate it on their behalf.",
    (name, ctx) =>
      Effect.gen(function* () {
        if (!(yield* mcp.supportsOAuth(name))) throw new Error(`MCP server ${name} does not support OAuth`)
        const bridge = yield* EffectBridge.make()
        return yield* mcp.authenticate(name, (url) => {
          bridge.fork(ctx.metadata({ title: `Authorize MCP: ${name}`, metadata: { name, authorizationUrl: url } }))
        })
      }),
  )
  const logout = yield* named(
    "mcp_logout",
    "Disconnect an MCP server and remove its stored OAuth tokens and client registration. Keeps server configuration. Authenticate again with mcp_auth when needed.",
    (name) => mcp.disconnect(name).pipe(Effect.andThen(mcp.removeAuth(name)), Effect.as({ success: true })),
  )

  const management = [list, add, remove, connect, disconnect, reconnect, auth, logout]
  const discovery = yield* Tool.define(
    "mcp_tools",
    Effect.succeed({
      description:
        "Load MCP server management tools when the user asks about MCP setup, authentication, connections, or configuration. Call this first; management tools become available on the next model turn for the current user request.",
      parameters: Schema.Struct({}),
      execute: () =>
        Effect.gen(function* () {
          const tools = yield* Effect.forEach(management, (tool) => Tool.init(tool))
          return {
            title: "Load MCP management tools",
            output: [
              "MCP management tools are available on the next model turn for this user request:",
              ...tools.map((tool) => `- ${tool.id}: ${tool.description}`),
            ].join("\n"),
            metadata: { mcpManagement: true },
          }
        }),
    }),
  )
  return [discovery, ...management]
})

export function managementRequested(messages: SessionV1.WithParts[]) {
  const index = messages.findLastIndex((message) => message.info.role === "user")
  if (index < 0) return false
  const user = messages[index].info
  // Derive activation from completed history, scoped to this request, rather than process-local state.
  return messages
    .slice(index + 1)
    .some(
      (message) =>
        message.info.role === "assistant" &&
        message.info.parentID === user.id &&
        message.info.sessionID === user.sessionID &&
        message.parts.some(
          (part) =>
            part.type === "tool" &&
            part.tool === "mcp_tools" &&
            part.state.status === "completed" &&
            part.state.metadata.mcpManagement === true,
        ),
    )
}

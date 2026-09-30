import { lazyCommand } from "./lazy"

// Keep metadata lightweight; command options and nested builders load on demand.
export const commands = [
  lazyCommand({ command: "acp", describe: "start ACP (Agent Client Protocol) server" }, async () => {
    const { AcpCommand } = await import("./cmd/acp")
    return AcpCommand
  }),
  lazyCommand({ command: "mcp", describe: "manage MCP (Model Context Protocol) servers" }, async () => {
    const { McpCommand } = await import("./cmd/mcp")
    return McpCommand
  }),
  lazyCommand({ command: "$0 [project]", describe: "start orangecode tui" }, async () => {
    const { TuiThreadCommand } = await import("./cmd/tui")
    return TuiThreadCommand
  }),
  lazyCommand({ command: "attach <url>", describe: "attach to a running orangecode server" }, async () => {
    const { AttachCommand } = await import("./cmd/attach")
    return AttachCommand
  }),
  lazyCommand({ command: "run [message..]", describe: "run orangecode with a message" }, async () => {
    const { RunCommand } = await import("./cmd/run")
    return RunCommand
  }),
  lazyCommand({ command: "generate" }, async () => {
    const { GenerateCommand } = await import("./cmd/generate")
    return GenerateCommand
  }),
  lazyCommand({ command: "debug", describe: "debugging and troubleshooting tools" }, async () => {
    const { DebugCommand } = await import("./cmd/debug")
    return DebugCommand
  }),
  lazyCommand({ command: "console", describe: false }, async () => {
    const { ConsoleCommand } = await import("./cmd/account")
    return ConsoleCommand
  }),
  lazyCommand(
    { command: "providers", aliases: ["auth"], describe: "manage AI providers and credentials" },
    async () => {
      const { ProvidersCommand } = await import("./cmd/providers")
      return ProvidersCommand
    },
  ),
  lazyCommand({ command: "agent", describe: "manage agents" }, async () => {
    const { AgentCommand } = await import("./cmd/agent")
    return AgentCommand
  }),
  lazyCommand(
    { command: "upgrade [target]", describe: "upgrade orangecode to the latest or a specific version" },
    async () => {
      const { UpgradeCommand } = await import("./cmd/upgrade")
      return UpgradeCommand
    },
  ),
  lazyCommand({ command: "uninstall", describe: "uninstall orangecode and remove all related files" }, async () => {
    const { UninstallCommand } = await import("./cmd/uninstall")
    return UninstallCommand
  }),
  lazyCommand({ command: "serve", describe: "starts a headless orangecode server" }, async () => {
    const { ServeCommand } = await import("./cmd/serve")
    return ServeCommand
  }),
  lazyCommand({ command: "server [action]", describe: "manage the shared local background server" }, async () => {
    const { ServerCommand } = await import("./cmd/server")
    return ServerCommand
  }),
  lazyCommand({ command: "web", describe: "start orangecode server and open web interface" }, async () => {
    const { WebCommand } = await import("./cmd/web")
    return WebCommand
  }),
  lazyCommand({ command: "models [provider]", describe: "list all available models" }, async () => {
    const { ModelsCommand } = await import("./cmd/models")
    return ModelsCommand
  }),
  lazyCommand({ command: "stats", describe: "show token usage and cost statistics" }, async () => {
    const { StatsCommand } = await import("./cmd/stats")
    return StatsCommand
  }),
  lazyCommand({ command: "export [sessionID]", describe: "export session data as JSON" }, async () => {
    const { ExportCommand } = await import("./cmd/export")
    return ExportCommand
  }),
  lazyCommand({ command: "import <file>", describe: "import session data from JSON file or URL" }, async () => {
    const { ImportCommand } = await import("./cmd/import")
    return ImportCommand
  }),
  lazyCommand({ command: "github", describe: "manage GitHub agent" }, async () => {
    const { GithubCommand } = await import("./cmd/github")
    return GithubCommand
  }),
  lazyCommand(
    { command: "pr <number>", describe: "fetch and checkout a GitHub PR branch, then run orangecode" },
    async () => {
      const { PrCommand } = await import("./cmd/pr")
      return PrCommand
    },
  ),
  lazyCommand({ command: "session", describe: "manage sessions" }, async () => {
    const { SessionCommand } = await import("./cmd/session")
    return SessionCommand
  }),
  lazyCommand(
    { command: "plugin <module>", aliases: ["plug"], describe: "install plugin and update config" },
    async () => {
      const { PluginCommand } = await import("./cmd/plug")
      return PluginCommand
    },
  ),
  lazyCommand({ command: "db", describe: "database tools" }, async () => {
    const { DbCommand } = await import("./cmd/db")
    return DbCommand
  }),
]

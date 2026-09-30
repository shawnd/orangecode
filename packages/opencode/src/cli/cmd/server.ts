import { cmd } from "./cmd"
import { Daemon } from "../daemon"
import { UI } from "../ui"

export const ServerCommand = cmd({
  command: "server [action]",
  describe: "manage the shared local background server",
  builder: (yargs) =>
    yargs
      .positional("action", { type: "string", choices: ["start", "status", "stop"] as const, default: "status" })
      .option("daemon", { type: "boolean", hidden: true }),
  handler: async (args) => {
    if (args.daemon) {
      const { run } = await import("../daemon-server")
      await run()
      return
    }
    const client = args.action === "start" ? await Daemon.ensure() : await Daemon.read()
    if (!client) {
      UI.println("OpenCode background server is not running")
      return
    }
    if (args.action === "stop") {
      await Daemon.request(client, "stop")
      const deadline = Date.now() + 30_000
      while (true) {
        try {
          process.kill(client.status.pid, 0)
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") break
          throw error
        }
        if (Date.now() >= deadline) throw new Error("Timed out stopping OpenCode background server")
        await Bun.sleep(50)
      }
      UI.println("OpenCode background server stopped")
      return
    }
    UI.println(`OpenCode background server ${client.status.version} (PID ${client.status.pid})`)
    UI.println(`Endpoint: ${Daemon.directory()}`)
  },
})

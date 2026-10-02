import { cmd } from "@/cli/cmd/cmd"
import { Rpc } from "@/util/rpc"
import { type rpc } from "../tui/worker"
import path from "path"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import { errorMessage } from "@opencode-ai/tui/util/error"
import { withTimeout } from "@/util/timeout"
import { withNetworkOptions, resolveNetworkOptionsNoConfig, hasArg } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import { writeHeapSnapshot } from "v8"
import { ServerAuth } from "@/server/auth"
import { validateSession } from "../tui/validate-session"
import { win32InstallCtrlCGuard } from "@opencode-ai/tui/terminal-win32"
import { getEarlyInput, stopEarlyInput } from "../early-input"
import { restartArgs, restartProcess } from "../restart"
import { Daemon } from "../daemon"

declare global {
  const OPENCODE_WORKER_PATH: string
}

export async function stopWorker(input: {
  warming: Promise<unknown>
  shutdown: () => Promise<unknown>
  terminate: () => Promise<unknown>
}) {
  try {
    await withTimeout(input.warming.then(input.shutdown), 5000).catch(() => {})
  } finally {
    await input.terminate()
  }
}

async function target() {
  if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
  const dist = new URL("./cli/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return dist
  return new URL("../tui/worker.ts", import.meta.url)
}

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

export function resolveThreadDirectory(project?: string, envPWD = process.env.PWD, cwd = process.cwd()) {
  const root = Filesystem.resolve(envPWD ?? cwd)
  if (project) return Filesystem.resolve(path.isAbsolute(project) ? project : path.join(root, project))
  return Filesystem.resolve(cwd)
}

export async function startTuiWorker(file: string | URL, network: Parameters<typeof rpc.server>[0], timeout = 10_000) {
  const worker = new Worker(file, {
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  })
  const client = Rpc.client<typeof rpc>(worker)
  let stopping: Promise<void> | undefined
  const stop = () =>
    (stopping ??= stopWorker({
      warming: Promise.resolve(),
      shutdown: () => client.call("shutdown", undefined),
      terminate: async () => {
        client.dispose()
        await worker.terminate()
      },
    }))
  const server = await withTimeout(client.call("server", network), timeout, "TUI worker startup timed out").catch(
    async (error) => {
      await stop()
      throw error
    },
  )
  return { client, server, stop }
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start orangecode tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start orangecode in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("auto", {
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        default: false,
      })
      .option("yolo", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("mini", {
        type: "boolean",
        describe: "start the minimal interactive interface",
        default: false,
      })
      .option("replay", {
        type: "boolean",
        hidden: true,
      })
      .option("no-replay", {
        type: "boolean",
        describe: "disable mini session history replay on resume and after resize",
      })
      .option("replay-limit", {
        type: "number",
        describe: "cap visible mini replay to the newest N messages",
      })
      .option("demo", {
        type: "boolean",
        hidden: true,
      }),
  handler: async (args) => {
    if (args.replay === true) {
      UI.error("--replay is not supported; replay is enabled by default")
      process.exitCode = 1
      return
    }
    const noReplay = args.replay === false || args.noReplay === true

    if (args.mini) {
      const network = ["--port", "--hostname", "--mdns", "--no-mdns", "--mdns-domain", "--cors"].find((option) =>
        process.argv.some((arg) => arg === option || arg.startsWith(option + "=")),
      )
      if (network) {
        UI.error(`${network} cannot be used with --mini`)
        process.exitCode = 1
        return
      }

      const { runMini } = await import("./run")
      await runMini({
        directory: resolveThreadDirectory(args.project),
        continue: args.continue,
        session: args.session,
        fork: args.fork,
        model: args.model,
        agent: args.agent,
        prompt: args.prompt,
        replay: noReplay ? false : undefined,
        replayLimit: args.replayLimit,
        demo: args.demo,
      })
      return
    }

    const unsupported = [
      ["--no-replay", noReplay],
      ["--replay-limit", args.replayLimit !== undefined],
      ["--demo", args.demo !== undefined],
    ].find((entry) => entry[1])?.[0]
    if (unsupported) {
      UI.error(`${unsupported} requires --mini`)
      process.exitCode = 1
      return
    }

    const unguard = win32InstallCtrlCGuard()
    let restart: string[] | undefined
    try {
      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      // Resolve relative --project paths from PWD, then use the real cwd after
      // chdir so the thread and worker share the same directory key.
      const next = resolveThreadDirectory(args.project)
      try {
        process.chdir(next)
      } catch {
        await stopEarlyInput()
        UI.error("Failed to change directory to " + next)
        process.exitCode = 1
        return
      }
      const cwd = Filesystem.resolve(process.cwd())
      const network = resolveNetworkOptionsNoConfig(args)
      const external = hasArg("--port") || hasArg("--hostname") || network.mdns === true

      const transport = await (async () => {
        if (!external) {
          const client = await Daemon.ensure()
          return {
            ...client,
            events: undefined,
            stop: async () => {},
            reload: () => Daemon.request(client, "reload"),
            checkUpgrade: () => Daemon.request(client, "upgrade", { directory: cwd }),
            attach: () => Daemon.attach(client),
            snapshot: async () => {
              const { Schema } = await import("effect")
              const response = await Daemon.request(client, "snapshot")
              return Schema.decodeUnknownSync(Schema.String)(await response.json())
            },
          }
        }
        const { client, server, stop } = await startTuiWorker(await target(), network)
        return {
          url: server.url,
          fetch: undefined,
          events: undefined,
          headers: ServerAuth.headers(),
          stop,
          reload: () => client.call("reload", undefined),
          checkUpgrade: () => client.call("checkUpgrade", { directory: cwd }),
          attach: async () => ({ url: server.url, headers: ServerAuth.headers() }),
          snapshot: () => client.call("snapshot", undefined),
        }
      })()
      const reload = () => {
        transport.reload().catch(() => {})
      }
      process.on("SIGUSR2", reload)

      try {
        const validation = validateSession({
          url: transport.url,
          sessionID: args.session,
          directory: cwd,
          fetch: transport.fetch,
          headers: transport.headers,
        })
        // Session validation and backend warmup overlap UI/config imports,
        // including resumes and flag combinations without an early prompt.
        const [config, prompt, { Effect }, { run }, { createLegacyTuiPluginHost }] = await Promise.all([
          (async () => {
            const { TuiConfig } = await import("@/config/tui")
            // Config loading can start dependency installs with their own lifetime.
            await validation
            return TuiConfig.get()
          })(),
          input(args.prompt),
          import("effect"),
          import("../tui/layer"),
          import("@/plugin/tui/runtime"),
          validation,
        ])
        setTimeout(() => {
          transport.checkUpgrade().catch(() => {})
        }, 1000).unref?.()
        const requested = await Effect.runPromise(
          run({
            url: transport.url,
            onAttach: transport.attach,
            async onSnapshot() {
              const tui = writeHeapSnapshot("tui.heapsnapshot")
              const server = await transport.snapshot()
              return [tui, server]
            },
            config,
            earlyInput: getEarlyInput(),
            pluginHost: createLegacyTuiPluginHost(),
            directory: cwd,
            fetch: transport.fetch,
            headers: transport.headers,
            events: transport.events,
            args: {
              continue: args.continue,
              sessionID: args.session,
              agent: args.agent,
              model: args.model,
              prompt,
              fork: args.fork,
              auto: args.auto || args.yolo || args["dangerously-skip-permissions"],
            },
          }),
        )
        if (requested) {
          restart = restartArgs(requested, {
            auto: args.auto || args.yolo || args["dangerously-skip-permissions"],
            network: external ? network : undefined,
          })
        }
      } catch (error) {
        await stopEarlyInput()
        UI.error(errorMessage(error))
        process.exitCode = 1
        return
      } finally {
        process.off("SIGUSR2", reload)
        await transport.stop()
      }
    } finally {
      await stopEarlyInput()
      try {
        unguard?.()
      } catch {}
    }
    if (restart) await restartProcess(restart)
    process.exit()
  },
})
// scratch

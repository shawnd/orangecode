import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { EOL } from "os"
import { commands } from "./commands"
import { parseCommands } from "./lazy"

const args = hideBin(process.argv)

// A bare version request needs neither the default command's builder nor its
// runtime. Mixed arguments still go through yargs with the full CLI contract.
if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
  process.stdout.write(InstallationVersion + EOL)
  process.exit()
}

const output: string[] = []
const invalid = Symbol("invalid arguments")

function show(out: string) {
  output.push(out)
}

try {
  await parseCommands(() => {
    const cli = yargs(args)
      .parserConfiguration({ "populate--": true })
      .scriptName("oc")
      .wrap(100)
      .help("help", "show help")
      .alias("help", "h")
      .version("version", "show version number", InstallationVersion)
      .alias("version", "v")
      .option("print-logs", {
        describe: "print logs to stderr",
        type: "boolean",
      })
      .option("log-level", {
        describe: "log level",
        type: "string",
        choices: ["DEBUG", "INFO", "WARN", "ERROR"],
      })
      .option("pure", {
        describe: "run without external plugins",
        type: "boolean",
      })
      .middleware(async (opts) => {
        if (opts.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
        if (opts.logLevel) process.env.OPENCODE_LOG_LEVEL = opts.logLevel
        if (opts.pure) {
          process.env.OPENCODE_PURE = "1"
        }

        const { Heap } = await import("./heap")
        Heap.start()

        process.env.AGENT = "1"
        process.env.OPENCODE = "1"
        process.env.OPENCODE_PID = String(process.pid)
      })
      .usage("")
      .completion("completion", "generate shell completion script")

    for (const register of commands) register(cli)

    cli
      .fail((msg, err) => {
        if (
          msg?.startsWith("Unknown argument") ||
          msg?.startsWith("Not enough non-option arguments") ||
          msg?.startsWith("Invalid values:")
        ) {
          if (err) throw err
          cli.showHelp(show)
        }
        if (err) throw err
        throw invalid
      })
      .strict()

    if (args.includes("-h") || args.includes("--help")) {
      return cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
        if (err) throw err
        if (!out) return
        show(out)
      })
    }
    return cli.parse()
  })
} catch (e) {
  if (e !== invalid) {
    const { UI } = await import("./ui")
    const { FormatError } = await import("./error")
    const { errorMessage } = await import("../util/error")
    const formatted = FormatError(e)
    if (formatted) UI.error(formatted)
    if (formatted === undefined) {
      UI.error("Unexpected error" + EOL)
      process.stderr.write(errorMessage(e) + EOL)
    }
  }
  process.exitCode = 1
} finally {
  for (const out of output) {
    const text = out.trimStart()
    if (!text.startsWith("oc ")) {
      const { UI } = await import("./ui")
      process.stderr.write(UI.logo() + EOL + EOL)
      process.stderr.write(text + EOL)
      continue
    }
    process.stderr.write(out)
  }
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}

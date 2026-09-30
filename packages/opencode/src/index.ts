import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { EOL } from "os"
import { commands } from "./cli/commands"
import { parseCommands } from "./cli/lazy"

const args = hideBin(process.argv)

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
      .option("print-logs", { describe: "print logs to stderr", type: "boolean" })
      .option("log-level", {
        describe: "log level",
        type: "string",
        choices: ["DEBUG", "INFO", "WARN", "ERROR"],
      })
      .option("pure", { describe: "run without external plugins", type: "boolean" })
      .middleware(async (opts) => {
        if (opts.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
        if (opts.logLevel) process.env.OPENCODE_LOG_LEVEL = opts.logLevel
        if (opts.pure) process.env.OPENCODE_PURE = "1"
        const { Heap } = await import("./cli/heap")
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
        if (out) show(out)
      })
    }
    return cli.parse()
  })
} catch (error) {
  if (error !== invalid) {
    const { UI } = await import("./cli/ui")
    const { FormatError } = await import("./cli/error")
    const { errorMessage } = await import("./util/error")
    const formatted = FormatError(error)
    if (formatted) UI.error(formatted)
    if (formatted === undefined) {
      UI.error("Unexpected error" + EOL)
      process.stderr.write(errorMessage(error) + EOL)
    }
  }
  process.exitCode = 1
} finally {
  for (const out of output) {
    const text = out.trimStart()
    if (!text.startsWith("oc ")) {
      const { UI } = await import("./cli/ui")
      process.stderr.write(UI.logo() + EOL + EOL)
      process.stderr.write(text + EOL)
      continue
    }
    process.stderr.write(out)
  }
  // Some subprocesses, including container-based MCP servers, do not react to
  // termination signals. Explicitly exit after the selected command completes.
  process.exit()
}

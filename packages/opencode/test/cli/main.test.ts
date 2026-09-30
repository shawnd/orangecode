import { expect, test } from "bun:test"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import path from "node:path"

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, "src/cli/main.ts", ...args], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { ...process.env, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

test.each(["--version", "-v"])("CLI main prints the bare version for %s", async (flag) => {
  expect(await run([flag])).toEqual({ code: 0, stdout: InstallationVersion + "\n", stderr: "" })
})

test("root help includes lazy commands, aliases, and the default TUI options", async () => {
  const result = await run(["--help"])
  expect(result.code).toBe(0)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("oc [project]")
  expect(result.stderr).toContain("start orangecode tui")
  expect(result.stderr).toContain("oc run [message..]")
  expect(result.stderr).not.toContain("opencode [project]")
  expect(result.stderr).not.toContain("run opencode")
  expect(result.stderr).toContain("[aliases: auth]")
  expect(result.stderr).toContain("[aliases: plug]")
  expect(result.stderr).toContain("--prompt")
  expect(result.stderr).toContain("--mini")
  expect(result.stderr).not.toContain("--demo")
})

test.each([
  ["providers", "login", "--provider"],
  ["auth", "login", "--provider"],
  ["mcp", "auth", "list"],
  ["db", "path", "print the database path"],
  ["debug", "lsp", "diagnostics <file>"],
])("nested help: %s %s", async (command, subcommand, expected) => {
  const result = await run([command, subcommand, "--help"])
  expect(result.code).toBe(0)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain(`oc ${command} ${subcommand}`)
  expect(result.stderr).toContain(expected)
})

test("completion loads nested option builders", async () => {
  const result = await run(["--get-yargs-completions", "oc", "providers", "login", "--"])
  expect(result.code).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout.split("\n")).toContain("--provider")
  expect(result.stdout.split("\n")).toContain("--method")
})

test("completion script remains available without selecting a command", async () => {
  const result = await run(["completion"])
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("--get-yargs-completions")
  expect(result.stdout).toContain("oc")
  expect(result.stdout).not.toContain("opencode")
  expect(result.stderr).toBe("")
})

test.each(
  [["attach"], ["run", "--format", "invalid"], ["--log-level", "invalid"], ["--unknown-option"]].map((args) => ({
    args,
  })),
)("invalid arguments retain usage and exit status: %j", async ({ args }) => {
  const result = await run(args)
  expect(result.code).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("Options:")
})

test.each(
  [
    ["--replay"],
    ["--print-logs", "--pure", "--log-level", "INFO", "--replay"],
    ["--prompt", "run", "--replay"],
    ["--replay", "--", "run"],
  ].map((args) => ({ args })),
)("default dispatch preserves flags and command-like values: %j", async ({ args }) => {
  const result = await run(args)
  expect(result.code).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("--replay is not supported; replay is enabled by default")
})

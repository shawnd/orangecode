import { expect, test } from "bun:test"
import path from "node:path"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import SKILL from "../../src/cli/skill.txt"

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, "src/index.ts", ...args], {
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

test.each(["--version", "-v"])("bare %s exits without loading command options", async (flag) => {
  expect(await run([flag])).toEqual({ code: 0, stdout: InstallationVersion + "\n", stderr: "" })
})

test.each([["--skill"], ["--skill", "--pure"]].map((args) => ({ args })))(
  "skill instructions exit without starting a session: %j",
  async ({ args }) => {
    const result = await run(args)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toStartWith("---\nname: orangecode\n")
    expect(result.stdout).toContain("oc run --session <session-id>")
    expect(result.stdout).toContain("herdr --skill")
    expect(result.stdout).not.toContain("\x1b")
    expect(result.stdout).toBe(SKILL)
  },
)

test("root help preserves command aliases and TUI options", async () => {
  const result = await run(["--help"])
  expect(result.code).toBe(0)
  expect(result.stderr).toContain("oc [project]")
  expect(result.stderr).toContain("[aliases: auth]")
  expect(result.stderr).toContain("[aliases: plug]")
  expect(result.stderr).toContain("oc server [action]")
  expect(result.stderr).toContain("--mini")
  expect(result.stderr).toContain("--prompt")
  expect(result.stderr).toContain("--skill")
})

test.each([
  ["server", "--help", "start"],
  ["providers", "login", "--provider"],
  ["debug", "lsp", "diagnostics <file>"],
])("nested help preserves original builders: %s %s", async (command, subcommand, expected) => {
  const result = await run([command, ...(subcommand === "--help" ? [] : [subcommand]), "--help"])
  expect(result.code).toBe(0)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain(expected)
})

test("nested completion preserves option discovery", async () => {
  const result = await run(["--get-yargs-completions", "oc", "providers", "login", "--"])
  expect(result.code).toBe(0)
  expect(result.stdout.split("\n")).toContain("--provider")
  expect(result.stdout.split("\n")).toContain("--method")
})

test.each(
  [
    ["attach"],
    ["--unknown-option"],
    ["run", "--format", "invalid"],
    ["--skill", "--unknown-option"],
    ["--skill", "--log-level", "invalid"],
  ].map((args) => ({ args })),
)("invalid arguments retain usage and failure exit: %j", async ({ args }) => {
  const result = await run(args)
  expect(result.code).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("Options:")
})

test.each([["--replay"], ["--prompt", "run", "--replay"], ["--replay", "--", "run"]].map((args) => ({ args })))(
  "default dispatch preserves command-like option values: %j",
  async ({ args }) => {
    const result = await run(args)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("--replay is not supported; replay is enabled by default")
  },
)

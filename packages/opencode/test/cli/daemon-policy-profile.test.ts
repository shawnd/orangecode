import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("daemon profile follows effective database selection and backend restrictions", async () => {
  await using tmp = await tmpdir()
  const profile = async (channel: string, settings: NodeJS.ProcessEnv = {}) => {
    const env = { ...process.env }
    for (const key of ["OPENCODE_DAEMON_DIR", "OPENCODE_DB", "OPENCODE_DISABLE_CHANNEL_DB", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_PERMISSION", "OPENCODE_PURE", "OPENCODE_DISABLE_DEFAULT_PLUGINS", "OPENCODE_DISABLE_EXTERNAL_SKILLS", "OPENCODE_DISABLE_LSP_DOWNLOAD", "OPENCODE_DISABLE_CLAUDE_CODE", "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT", "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", "OPENCODE_AUTO_SHARE"]) delete env[key]
    const child = Bun.spawn([process.execPath, "-e", `
      globalThis.OPENCODE_CHANNEL = ${JSON.stringify(channel)}
      const { Daemon } = await import("./src/cli/daemon.ts")
      const { Database } = await import("@opencode-ai/core/database/database")
      console.log(JSON.stringify({ directory: Daemon.directory(), database: Daemon.database(), actual: Database.path() }))
    `], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...env, ...settings }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, stderr).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.database).toBe(result.actual)
    return result.directory as string
  }
  const local = await profile("local")
  const latest = await profile("latest")
  expect(local).not.toBe(latest)
  expect(await profile("beta")).toBe(latest)
  expect(await profile("local", { OPENCODE_DISABLE_CHANNEL_DB: "1" })).toBe(latest)
  expect(await profile("local", { OPENCODE_DISABLE_CHANNEL_DB: "true" })).toBe(latest)
  expect(await profile("local", { OPENCODE_DISABLE_CHANNEL_DB: "false" })).toBe(local)
  const explicit = path.join(tmp.path, "selected.db")
  expect(await profile("local", { OPENCODE_DB: explicit })).toBe(await profile("other", { OPENCODE_DB: explicit, OPENCODE_DISABLE_CHANNEL_DB: "1" }))
  expect(await profile("local", { OPENCODE_DB: "opencode.db" })).toBe(latest)
  expect(await profile("local", { OPENCODE_DB: ":memory:" })).toBe(await profile("other", { OPENCODE_DB: ":memory:" }))
  expect(await profile("other")).not.toBe(local)
  const restricted = await profile("local", { OPENCODE_DISABLE_PROJECT_CONFIG: "1" })
  expect(restricted).not.toBe(local)
  expect(await profile("local", { OPENCODE_DISABLE_PROJECT_CONFIG: "true" })).toBe(restricted)
  expect(await profile("local", { OPENCODE_DISABLE_PROJECT_CONFIG: "false" })).toBe(local)
  const permission = await profile("local", { OPENCODE_PERMISSION: '{"bash":"deny"}' })
  expect(permission).not.toBe(local)
  expect(await profile("local", { OPENCODE_PERMISSION: '{ "bash": "deny" }' })).toBe(permission)
  expect(await profile("local", { OPENCODE_PURE: "1" })).not.toBe(local)
  for (const key of ["OPENCODE_DISABLE_DEFAULT_PLUGINS", "OPENCODE_DISABLE_EXTERNAL_SKILLS", "OPENCODE_DISABLE_LSP_DOWNLOAD", "OPENCODE_AUTO_SHARE"]) {
    expect(await profile("local", { [key]: "true" })).not.toBe(local)
    expect(await profile("local", { [key]: "false" })).toBe(local)
  }
  expect(await profile("local", { OPENCODE_DISABLE_CLAUDE_CODE: "true" })).toBe(await profile("local", { OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "true", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true" }))
  expect(await profile("local", { UNRELATED_CLIENT_SETTING: "different" })).toBe(local)
}, 40000)

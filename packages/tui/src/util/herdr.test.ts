import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { attachCommand } from "./herdr"

test("attach arguments survive shell parsing without expanding session or directory text", async () => {
  const input = {
    url: "http://127.0.0.1:4096",
    sessionID: "ses_'$(printf injected);$HOME",
    directory: "/tmp/project's folder/日本語",
  }
  const child = Bun.spawn(
    ["sh", "-c", attachCommand(input, [process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))"])],
    { stdout: "pipe", stderr: "pipe" },
  )
  expect(await new Response(child.stdout).json()).toEqual([
    "attach",
    input.url,
    "--session",
    input.sessionID,
    "--fork",
    "--dir",
    input.directory,
  ])
  expect(await child.exited).toBe(0)
  expect(() => attachCommand({ ...input, directory: "/tmp/project\nexit" })).toThrow("multiline")
})

for (const scenario of ["success", "split-failure", "outside-herdr"] as const) {
  test(`Herdr CLI integration: ${scenario}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opencode-herdr-"))
    try {
      const log = path.join(directory, "calls.jsonl")
      const executable = path.join(directory, "herdr")
      // Exercise the real subprocess boundary with a small standalone CLI fixture.
      await Bun.write(
        executable,
        `#!${process.execPath}
import { appendFileSync } from "node:fs"
const args = process.argv.slice(2)
appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + "\\n")
if (process.env.SCENARIO === "split-failure") {
  console.error("pane cannot be split")
  process.exit(1)
}
console.log(JSON.stringify({ result: { pane: { pane_id: "wZ:p42" } } }))
`,
      )
      await chmod(executable, 0o755)
      const runner = path.join(directory, "runner.ts")
      await Bun.write(
        runner,
        `import { splitSession } from ${JSON.stringify(path.join(import.meta.dir, "herdr.ts"))}
await splitSession({
  sessionID: "ses_current",
  directory: "/remote/project's folder",
  cwd: ${JSON.stringify(directory)},
  direction: "right",
  connection: async () => ({
    url: "http://localhost:4321",
    headers: { Authorization: "Basic " + Buffer.from("alice:secret:password").toString("base64") },
  }),
}).catch((error) => { console.error(error.message); process.exit(1) })`,
      )
      const child = Bun.spawn([process.execPath, runner], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          HERDR_ENV: scenario === "outside-herdr" ? "" : "1",
          CALL_LOG: log,
          SCENARIO: scenario,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const stderr = await new Response(child.stderr).text()
      expect(await child.exited).toBe(scenario === "success" ? 0 : 1)
      if (scenario === "outside-herdr") {
        expect(stderr).toContain("/split requires a Herdr pane")
        expect(await Bun.file(log).exists()).toBe(false)
        return
      }
      const calls = (await Bun.file(log).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(calls[0]).toEqual([
        "pane",
        "split",
        "--current",
        "--direction",
        "right",
        "--cwd",
        directory,
        "--no-focus",
        "--env",
        "OPENCODE_SERVER_USERNAME=alice",
        "--env",
        "OPENCODE_SERVER_PASSWORD=secret:password",
      ])
      if (scenario === "split-failure") {
        expect(stderr).toContain("pane cannot be split")
        expect(calls).toHaveLength(1)
        return
      }
      expect(calls).toHaveLength(2)
      expect(calls[1].slice(0, 3)).toEqual(["pane", "run", "wZ:p42"])
      expect(calls[1][3]).toContain("'oc' 'attach' 'http://localhost:4321' '--session' 'ses_current' '--fork'")
      expect(calls[1][3]).not.toContain("secret")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

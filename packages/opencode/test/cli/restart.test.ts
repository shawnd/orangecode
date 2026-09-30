import { expect, test } from "bun:test"
import path from "node:path"
import { rename } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { restartArgs } from "../../src/cli/restart"
import { tmpdir } from "../fixture/fixture"

test("restart resumes the current session in its directory with auto approval preserved", () => {
  expect(restartArgs({ sessionID: "ses_current", directory: "/work/current project" }, { auto: true })).toEqual([
    "/work/current project",
    "--session",
    "ses_current",
    "--auto",
  ])
})

test("restart from home does not continue or fork a previous session", () => {
  expect(restartArgs({ directory: "/work/project" })).toEqual(["/work/project"])
  expect(restartArgs({})).toEqual([])
})

test("attached restart reconnects with the same credentials and remote directory", () => {
  expect(
    restartArgs(
      { sessionID: "ses_current", directory: "/remote/project" },
      { attach: { url: "http://localhost:4096", username: "user", password: "" } },
    ),
  ).toEqual([
    "attach",
    "http://localhost:4096",
    "--dir",
    "/remote/project",
    "--username",
    "user",
    "--password",
    "",
    "--session",
    "ses_current",
  ])
})

test("restart preserves the local server listener options", () => {
  expect(
    restartArgs(
      { directory: "/work/project" },
      {
        network: {
          port: 4096,
          hostname: "0.0.0.0",
          mdns: true,
          mdnsDomain: "test.local",
          cors: ["https://first.example", "https://second.example"],
        },
      },
    ),
  ).toEqual([
    "/work/project",
    "--port",
    "4096",
    "--hostname",
    "0.0.0.0",
    "--mdns",
    "--mdns-domain",
    "test.local",
    "--cors",
    "https://first.example",
    "--cors",
    "https://second.example",
  ])
})

test.skipIf(process.platform === "win32")("restart replaces the process with inherited stdio", async () => {
  await using tmp = await tmpdir()
  const script = path.join(tmp.path, "restart.ts")
  await Bun.write(
    script,
    `import { restartProcess } from ${JSON.stringify(fileURLToPath(import.meta.resolve("../../src/cli/restart.ts")))}
if (process.argv[2] === "--resumed") {
  console.log(JSON.stringify({
    sameProcess: process.pid === Number(process.argv[3]),
    input: await Bun.stdin.text(),
    cwd: process.cwd(),
    inherited: process.env.RESTART_TEST,
    staleRoute: process.env.OPENCODE_ROUTE ?? null,
  }))
} else {
  process.chdir(${JSON.stringify(tmp.path)})
  await restartProcess(["--resumed", String(process.pid)])
}
`,
  )
  const child = Bun.spawn([process.execPath, script], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { ...process.env, RESTART_TEST: "kept", OPENCODE_ROUTE: '{"type":"home"}' },
    stdin: new TextEncoder().encode("terminal input"),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  expect(JSON.parse(stdout)).toEqual({
    sameProcess: true,
    input: "terminal input",
    cwd: tmp.path,
    inherited: "kept",
    staleRoute: null,
  })
})

test.skipIf(process.platform === "win32")("compiled restart loads an atomically replaced binary", async () => {
  await using tmp = await tmpdir()
  const script = path.join(tmp.path, "restart.ts")
  const binary = path.join(tmp.path, "restart")
  const source = `import { restartProcess } from ${JSON.stringify(fileURLToPath(import.meta.resolve("../../src/cli/restart.ts")))}
const version = "original"
if (process.argv[2] === "--resumed") {
  console.log(JSON.stringify({ version, sameProcess: process.pid === Number(process.argv[3]) }))
} else {
  console.log("ready")
  await Bun.stdin.text()
  await restartProcess(["--resumed", String(process.pid)])
}
`
  await Bun.write(script, source)
  await Bun.build({ entrypoints: [script], compile: { outfile: binary, autoloadBunfig: false } })
  const child = Bun.spawn([binary], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  try {
    const reader = child.stdout.getReader()
    const ready = await reader.read()
    if (ready.done) throw new Error(await new Response(child.stderr).text())
    expect(new TextDecoder().decode(ready.value)).toBe("ready\n")
    await Bun.write(script, source.replace('const version = "original"', 'const version = "updated"'))
    await Bun.build({ entrypoints: [script], compile: { outfile: binary + ".new", autoloadBunfig: false } })
    await rename(binary + ".new", binary)
    child.stdin.end()
    const stdout = [] as string[]
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      stdout.push(new TextDecoder().decode(chunk.value))
    }
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(JSON.parse(stdout.join(""))).toEqual({ version: "updated", sameProcess: true })
  } finally {
    child.kill()
    await child.exited
  }
})

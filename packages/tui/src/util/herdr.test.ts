import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises"
import { createServer } from "node:net"
import http from "node:http"
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
    "--dir",
    input.directory,
  ])
  expect(await child.exited).toBe(0)
  expect(() => attachCommand({ ...input, directory: "/tmp/project\nexit" })).toThrow("multiline")
})

for (const scenario of [
  "success",
  "split-failure",
  "run-failure",
  "outside-herdr",
  "public-socket",
  "symlink-socket",
  "unsafe-parent",
  "missing-socket",
  "malformed-response",
  "wrong-response-id",
  "oversized-response",
  "closed-socket",
  "unauthenticated",
] as const) {
  test(`Herdr confidential socket integration: ${scenario}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opencode-herdr-"))
    const calls: string[][] = []
    const requests: {
      method: string
      params: { env: Record<string, string>; cwd: string; direction: string; target_pane_id: string; focus: boolean }
    }[] = []
    const attached: { args: string[]; authorization: string }[] = []
    const authorization = "Basic " + Buffer.from("alice:secret:password").toString("base64")
    const backend = http.createServer((request, response) => {
      attached.push({
        args: JSON.parse(request.headers["x-attach-args"] as string),
        authorization: request.headers.authorization ?? "",
      })
      response.writeHead(
        request.headers.authorization === (scenario === "unauthenticated" ? undefined : authorization) ? 200 : 401,
      )
      response.end()
    })
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve))
    const address = backend.address()
    if (!address || typeof address === "string") throw new Error("No HTTP address")
    const url = `http://127.0.0.1:${address.port}`
    const socketPath = path.join(directory, "api.sock")
    const launchEnv: Record<string, string> = {}
    const server = createServer((socket) => {
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString()
        if (!buffer.includes("\n")) return
        const request = JSON.parse(buffer)
        if (request.method === "pane.split") {
          requests.push(request)
          Object.assign(launchEnv, request.params.env)
          if (scenario === "closed-socket") return socket.end()
          if (scenario === "malformed-response") return socket.end("not json\n")
          const response =
            scenario === "split-failure"
              ? { id: request.id, error: { message: "secret:password must not be echoed" } }
              : { id: scenario === "wrong-response-id" ? "other" : request.id, result: { pane: { pane_id: "wZ:p42" } } }
          // Exercise framing across multiple reads.
          const body = JSON.stringify({
            ...response,
            ...(scenario === "oversized-response" ? { padding: "x".repeat(1024 * 1024) } : {}),
          })
          socket.write(body.slice(0, 7))
          socket.end(body.slice(7) + "\n")
          return
        }
        calls.push(request.args)
        if (request.args[1] === "split") {
          request.args.forEach((arg: string, index: number) => {
            if (arg !== "--env") return
            const value: string = request.args[index + 1]
            launchEnv[value.slice(0, value.indexOf("="))] = value.slice(value.indexOf("=") + 1)
          })
          socket.end(JSON.stringify({ result: { pane: { pane_id: "wZ:p42" } } }) + "\n")
          return
        }
        if (scenario === "run-failure") return socket.end("failure\n")
        // Emulate Herdr's launch env at the actual child-process boundary. The
        // attach fixture performs a real authenticated request to a remote URL.
        const child = Bun.spawn(["sh", "-c", request.args[3]], {
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, ...launchEnv },
          stdout: "pipe",
          stderr: "pipe",
        })
        void child.exited.then((code) => socket.end(code === 0 ? "ok\n" : "failure\n"))
      })
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    await chmod(socketPath, scenario === "public-socket" ? 0o666 : 0o600)
    if (scenario === "unsafe-parent") await chmod(directory, 0o777)
    const link = path.join(directory, "link.sock")
    if (scenario === "symlink-socket") await symlink(socketPath, link)
    try {
      await Bun.write(
        path.join(directory, "herdr"),
        `#!${process.execPath}
import { createConnection } from "node:net"
const socket = createConnection(process.env.TEST_SOCKET, () => socket.write(JSON.stringify({ args: process.argv.slice(2) }) + "\\n"))
let response = ""
socket.on("data", (data) => response += data)
socket.on("end", () => { if (response.trim() === "failure") { console.error("pane run failed"); process.exitCode = 1 } else console.log(response.trim()) })
`,
      )
      await Bun.write(
        path.join(directory, "oc"),
        `#!${process.execPath}
const args = process.argv.slice(2)
const authorization = "Basic " + Buffer.from(process.env.OPENCODE_SERVER_USERNAME + ":" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64")
const response = await fetch(args[1], { headers: { ...(process.env.OPENCODE_SERVER_PASSWORD ? { authorization } : {}), "x-attach-args": JSON.stringify(args) } })
process.exitCode = response.status === 200 ? 0 : 1
`,
      )
      await chmod(path.join(directory, "herdr"), 0o755)
      await chmod(path.join(directory, "oc"), 0o755)
      const runner = path.join(directory, "runner.ts")
      await Bun.write(
        runner,
        `import { splitSession } from ${JSON.stringify(path.join(import.meta.dir, "herdr.ts"))}
await splitSession({
  sessionID: "ses_current", directory: "/remote/project's folder", cwd: ${JSON.stringify(directory)}, direction: "right",
  connection: async () => ({ url: ${JSON.stringify(url)}, headers: ${JSON.stringify(scenario === "unauthenticated" ? {} : { Authorization: authorization })} }),
}).catch((error) => { console.error(error.message); process.exitCode = 1 })`,
      )
      const child = Bun.spawn([process.execPath, runner], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          HERDR_ENV: scenario === "outside-herdr" ? "" : "1",
          HERDR_PANE_ID: "wZ:p1",
          HERDR_SOCKET_PATH: scenario === "missing-socket" ? "" : scenario === "symlink-socket" ? link : socketPath,
          TEST_SOCKET: socketPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const stderr = await new Response(child.stderr).text()
      expect(await child.exited).toBe(scenario === "success" || scenario === "unauthenticated" ? 0 : 1)
      expect(stderr).not.toContain("secret:password")
      if (scenario === "oversized-response") expect(stderr).toContain("response is too large")
      expect(JSON.stringify(calls)).not.toContain("secret:password")
      expect(JSON.stringify(calls)).not.toContain(authorization)
      if (["outside-herdr", "public-socket", "symlink-socket", "unsafe-parent", "missing-socket"].includes(scenario)) {
        expect(requests).toHaveLength(0)
        expect(calls).toHaveLength(0)
        return
      }
      if (scenario === "unauthenticated") {
        expect(requests).toHaveLength(0)
        expect(calls[0]).toContain("OPENCODE_SERVER_PASSWORD=")
        return
      }
      expect(requests).toHaveLength(1)
      expect(requests[0]?.params).toEqual({
        target_pane_id: "wZ:p1",
        direction: "right",
        cwd: directory,
        focus: false,
        env: { OPENCODE_SERVER_USERNAME: "alice", OPENCODE_SERVER_PASSWORD: "secret:password" },
      })
      if (scenario === "success") {
        expect(calls).toHaveLength(1)
        expect(calls[0]?.slice(0, 3)).toEqual(["pane", "run", "wZ:p42"])
        expect(attached).toEqual([
          {
            authorization,
            args: ["attach", url, "--session", "ses_current", "--dir", "/remote/project's folder"],
          },
        ])
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await new Promise<void>((resolve) => backend.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  })
}

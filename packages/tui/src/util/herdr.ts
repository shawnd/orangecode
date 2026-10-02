import type { AttachConnection } from "../context/sdk"
import { isRecord } from "./record"
import { lstat, realpath } from "node:fs/promises"
import { createConnection } from "node:net"
import path from "node:path"

export async function splitSession(input: {
  sessionID: string
  directory: string
  cwd: string
  direction: "right" | "down"
  connection: () => Promise<AttachConnection>
}) {
  if (process.env.HERDR_ENV !== "1") throw new Error("/split requires a Herdr pane")
  if (!Bun.which("herdr")) throw new Error("Herdr is not available in PATH")
  if (!Bun.which("oc")) throw new Error("oc is not available in PATH")

  const connection = await input.connection()
  const authorization = new Headers(connection.headers).get("authorization")
  if (authorization && !authorization.startsWith("Basic ")) {
    throw new Error("/split requires a server connection with Basic authentication or no authentication")
  }
  const credentials = authorization ? Buffer.from(authorization.slice(6), "base64").toString() : "opencode:"
  const separator = credentials.indexOf(":")
  if (separator < 0) throw new Error("Invalid server credentials")

  const command = attachCommand({ ...input, url: connection.url })
  const result: unknown = authorization
    ? await splitAuthenticatedPane({
        direction: input.direction,
        cwd: input.cwd,
        env: {
          OPENCODE_SERVER_USERNAME: credentials.slice(0, separator),
          OPENCODE_SERVER_PASSWORD: credentials.slice(separator + 1),
        },
      })
    : JSON.parse(
        await herdr([
          "pane",
          "split",
          "--current",
          "--direction",
          input.direction,
          "--cwd",
          input.cwd,
          "--no-focus",
          "--env",
          "OPENCODE_SERVER_USERNAME=opencode",
          "--env",
          "OPENCODE_SERVER_PASSWORD=",
        ]),
      )
  const pane = isRecord(result) && isRecord(result.result) && result.result.pane
  if (!isRecord(pane) || typeof pane.pane_id !== "string") throw new Error("Herdr did not return a new pane ID")
  await herdr(["pane", "run", pane.pane_id, command]).catch((error) => {
    throw new Error(`Created Herdr pane ${pane.pane_id}, but could not open the session`, { cause: error })
  })
}

async function splitAuthenticatedPane(input: {
  direction: "right" | "down"
  cwd: string
  env: Record<string, string>
}) {
  const socketPath = process.env.HERDR_SOCKET_PATH
  const paneID = process.env.HERDR_PANE_ID
  if (!socketPath || !paneID || !process.getuid) {
    throw new Error("Authenticated /split requires a private Herdr Unix API socket and HERDR_PANE_ID")
  }
  const socket = await lstat(socketPath)
  if (!socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o077) !== 0) {
    throw new Error("Herdr API socket must be owned by the current user and private")
  }
  // Validate resolved ancestry too: a private socket in a replaceable directory
  // is not a confidential destination. Root-owned sticky /tmp is safe.
  const resolved = await realpath(socketPath)
  for (let directory = path.dirname(resolved); ; directory = path.dirname(directory)) {
    const parent = await lstat(directory)
    if (
      !parent.isDirectory() ||
      (parent.uid !== process.getuid() && parent.uid !== 0) ||
      ((parent.mode & 0o022) !== 0 && !(parent.uid === 0 && (parent.mode & 0o1000) !== 0))
    ) {
      throw new Error("Herdr API socket has unsafe directory ownership or permissions")
    }
    if (directory === path.dirname(directory)) break
  }

  // Herdr's pane.split API accepts launch env over its private JSON-line socket.
  // Its CLI --env option puts values in argv, even when the CLI inherits env.
  const id = crypto.randomUUID()
  return new Promise<unknown>((resolve, reject) => {
    const client = createConnection(resolved, () => {
      client.write(
        JSON.stringify({ id, method: "pane.split", params: { ...input, target_pane_id: paneID, focus: false } }) + "\n",
      )
    })
    const chunks: Buffer[] = []
    const finish = (error?: Error, result?: unknown) => {
      client.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    client.setTimeout(10_000, () => finish(new Error("Herdr API request timed out")))
    client.on("error", (error) => finish(error))
    client.on("end", () => finish(new Error("Herdr API closed without a response")))
    client.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
      const response = Buffer.concat(chunks)
      if (response.length > 1024 * 1024) return finish(new Error("Herdr API response is too large"))
      const newline = response.indexOf(10)
      if (newline < 0) return
      void Promise.resolve()
        .then(() => {
          const result: unknown = JSON.parse(response.subarray(0, newline).toString())
          if (!isRecord(result) || result.id !== id) return finish(new Error("Invalid Herdr API response"))
          // Do not echo a remote error body that could contain the launch env.
          if (result.error) return finish(new Error("Herdr could not split the pane"))
          finish(undefined, result)
        })
        .catch(() => finish(new Error("Invalid Herdr API response")))
    })
  })
}

export function attachCommand(input: { url: string; sessionID: string; directory: string }, executable = ["oc"]) {
  return [...executable, "attach", input.url, "--session", input.sessionID, "--dir", input.directory]
    .map((arg) => {
      if (/[\r\n\0]/.test(arg)) throw new Error("Cannot send a multiline command to a Herdr pane")
      return "'" + arg.replaceAll("'", "'\"'\"'") + "'"
    })
    .join(" ")
}

async function herdr(args: string[]) {
  const child = Bun.spawn(["herdr", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(stderr.trim() || `Herdr exited with status ${code}`)
  return stdout
}

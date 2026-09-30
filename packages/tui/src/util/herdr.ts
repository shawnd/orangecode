import type { AttachConnection } from "../context/sdk"
import { isRecord } from "./record"

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
  const result: unknown = JSON.parse(
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
      `OPENCODE_SERVER_USERNAME=${credentials.slice(0, separator)}`,
      "--env",
      `OPENCODE_SERVER_PASSWORD=${credentials.slice(separator + 1)}`,
    ]),
  )
  const pane = isRecord(result) && isRecord(result.result) && result.result.pane
  if (!isRecord(pane) || typeof pane.pane_id !== "string") throw new Error("Herdr did not return a new pane ID")
  await herdr(["pane", "run", pane.pane_id, command]).catch((error) => {
    throw new Error(`Created Herdr pane ${pane.pane_id}, but could not open the session`, { cause: error })
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

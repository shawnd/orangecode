import path from "node:path"
import os from "node:os"
import { chmod, mkdir, open } from "node:fs/promises"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createHash, randomBytes } from "node:crypto"
import { Config, Effect, Option, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { workerConfig } from "@opencode-ai/core/filesystem/fff-types"
import { Flag } from "@opencode-ai/core/flag/flag"

export const Status = Schema.Struct({
  protocol: Schema.Number,
  version: Schema.String,
  pid: Schema.Number,
  started: Schema.Number,
})

export const Endpoint = Schema.Struct({
  url: Schema.String,
  socket: Schema.optional(Schema.String),
  password: Schema.String,
})

export type Connection = {
  url: string
  fetch?: typeof fetch
  headers: { Authorization: string }
}

export const protocol = 1

export function directory() {
  if (process.env.OPENCODE_DAEMON_DIR) return path.resolve(process.env.OPENCODE_DAEMON_DIR)
  // Explicit config profiles must not borrow a daemon initialized with another
  // profile. Project directories are selected per request, not part of this key.
  const search = workerConfig(process.env)
  const searchIdleMs = Flag.OPENCODE_EXPERIMENTAL_SEARCH_IDLE_MS
  const jobOutputRelease = Effect.runSync(
    Config.boolean("OPENCODE_EXPERIMENTAL_JOB_OUTPUT_RELEASE").pipe(Config.withDefault(false)),
  )
  const profile = createHash("sha256")
    .update(
      JSON.stringify([
        Global.Path.state,
        Global.Path.data,
        Global.Path.config,
        Global.Path.cache,
        process.env.OPENCODE_PURE,
        process.env.OPENCODE_CONFIG ? path.resolve(process.env.OPENCODE_CONFIG) : undefined,
        process.env.OPENCODE_CONFIG_DIR ? path.resolve(process.env.OPENCODE_CONFIG_DIR) : undefined,
        process.env.OPENCODE_CONFIG_CONTENT,
        process.env.OPENCODE_DB,
        ...(search.enabled ? [search] : []),
        // Attached clients must not borrow a daemon launched with a different
        // opt-in resource policy. Disabled policies preserve the existing key.
        ...(searchIdleMs === undefined ? [] : [{ searchIdleMs }]),
        ...(jobOutputRelease ? [{ jobOutputRelease }] : []),
      ]),
    )
    .digest("hex")
    .slice(0, 12)
  const root = process.env.XDG_RUNTIME_DIR ?? os.tmpdir()
  return path.join(root, `opencode-${process.getuid?.() ?? os.userInfo().username}`, profile)
}

export function connection(endpoint: typeof Endpoint.Type): Connection {
  const socket = endpoint.socket
  return {
    url: endpoint.url,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString("base64")}` },
    fetch: socket
      ? Object.assign((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, unix: socket }), {
          preconnect: fetch.preconnect,
        })
      : undefined,
  }
}

export async function read(dir = directory()) {
  const text = await Bun.file(path.join(dir, "server.json"))
    .text()
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
  if (!text) return undefined
  const endpoint = Schema.decodeUnknownOption(Schema.fromJsonString(Endpoint))(text)
  if (Option.isNone(endpoint)) throw new Error(`Invalid daemon endpoint: ${path.join(dir, "server.json")}`)
  const client = connection(endpoint.value)
  const response = await (client.fetch ?? fetch)(new URL("/__daemon/status", client.url), {
    headers: client.headers,
    signal: AbortSignal.timeout(1000),
  }).catch((error: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" ||
        error.code === "ECONNREFUSED" ||
        error.code === "ECONNRESET" ||
        error.code === "FailedToOpenSocket")
    )
      return undefined
    throw new Error(`OpenCode daemon is not responding. See ${path.join(dir, "server.log")}`, { cause: error })
  })
  if (!response) return undefined
  if (!response.ok) throw new Error(`Cannot access OpenCode daemon (${response.status})`)
  const status = Schema.decodeUnknownOption(Status)(await response.json())
  if (Option.isNone(status)) throw new Error("OpenCode daemon returned an invalid status")
  return { ...client, status: status.value }
}

export async function ensure(dir = directory()) {
  const current = await read(dir)
  if (current) return compatible(current)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  return Flock.withLock(
    "startup",
    async () => {
      const current = await read(dir)
      if (current) return compatible(current)
      const log = await open(path.join(dir, "server.log"), "a", 0o600)
      const source = /^(bun|node)(\.exe)?$/.test(path.basename(process.execPath))
      const child = spawn(
        process.execPath,
        [...(source ? [fileURLToPath(new URL("../index.ts", import.meta.url))] : []), "server", "--daemon"],
        {
          cwd: os.homedir(),
          env: {
            ...process.env,
            OPENCODE_DAEMON_DIR: dir,
            // Legacy plugin clients capture these flags during module loading.
            // Seed the daemon process before it imports any backend modules.
            OPENCODE_SERVER_USERNAME: "opencode",
            OPENCODE_SERVER_PASSWORD: randomBytes(32).toString("hex"),
            OPENCODE_CONFIG: process.env.OPENCODE_CONFIG ? path.resolve(process.env.OPENCODE_CONFIG) : undefined,
            OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR
              ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
              : undefined,
          },
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
          windowsHide: true,
        },
      )
      let failure: Error | undefined
      child.once("error", (error) => {
        failure = error
      })
      child.unref()
      await log.close()
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const ready = await read(dir)
        if (ready) return compatible(ready)
        if (failure || child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`OpenCode daemon failed to start. See ${path.join(dir, "server.log")}`, { cause: failure })
        }
        await Bun.sleep(50)
      }
      throw new Error(`Timed out starting OpenCode daemon. See ${path.join(dir, "server.log")}`)
    },
    { dir: path.join(dir, "locks"), timeoutMs: 60_000, staleMs: 30_000, baseDelayMs: 50, maxDelayMs: 100 },
  )
}

function compatible(client: NonNullable<Awaited<ReturnType<typeof read>>>) {
  if (client.status.protocol !== protocol) {
    throw new Error(
      `OpenCode daemon ${client.status.version} (protocol ${client.status.protocol}) is incompatible with client ${InstallationVersion} (protocol ${protocol}). Run 'oc server stop' and retry.`,
    )
  }
  return client
}

export async function request(client: Connection, action: string, body?: unknown) {
  const response = await (client.fetch ?? fetch)(new URL(`/__daemon/${action}`, client.url), {
    method: "POST",
    headers: { ...client.headers, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Daemon ${action} failed: ${await response.text()}`)
  return response
}

export async function attach(client: Connection) {
  const response = await request(client, "listen")
  const endpoint = Schema.decodeUnknownOption(Endpoint)(await response.json())
  if (Option.isNone(endpoint)) throw new Error("OpenCode daemon returned an invalid attachment endpoint")
  return { ...connection(endpoint.value), password: endpoint.value.password }
}

export * as Daemon from "./daemon"

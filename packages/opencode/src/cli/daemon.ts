import path from "node:path"
import os from "node:os"
import { chmod, lstat, mkdir, open } from "node:fs/promises"
import { constants } from "node:fs"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createHash, createHmac, randomBytes } from "node:crypto"
import { Config, Effect, Option, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { workerConfig } from "@opencode-ai/core/filesystem/fff-types"
import { Flag } from "@opencode-ai/core/flag/flag"

export const Status = Schema.Struct({
  protocol: Schema.Number,
  version: Schema.String,
  pid: Schema.Number,
  started: Schema.Number,
  stopping: Schema.optional(Schema.Boolean),
  policy: Schema.optional(Schema.String),
})

export const Endpoint = Schema.Struct({
  url: Schema.String,
  socket: Schema.optional(Schema.String),
  password: Schema.String,
  pid: Schema.optional(Schema.Number),
  identity: Schema.optional(Schema.Literal("hmac-sha256-v1")),
})

export type Connection = {
  url: string
  fetch?: typeof fetch
  headers: { Authorization: string }
}

export const protocol = 1

export function proof(password: string, nonce: string, kind: "request" | "response") {
  return createHmac("sha256", password).update(`opencode-daemon:${kind}:${nonce}`).digest("hex")
}

export function database() {
  const explicit = process.env.OPENCODE_DB
  if (explicit) return explicit === ":memory:" ? explicit : path.resolve(Global.Path.data, explicit)
  const shared =
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    ["1", "true"].includes(process.env.OPENCODE_DISABLE_CHANNEL_DB ?? "")
  return path.join(
    Global.Path.data,
    shared ? "opencode.db" : `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`,
  )
}

// Only backend policy belongs here: unrelated client environment changes should
// continue to share a backend. Also checked on reuse of an explicit directory.
export function policy() {
  return createHash("sha256").update(JSON.stringify([database(), restrictions()])).digest("hex")
}

function restrictions() {
  const permission = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(
    process.env.OPENCODE_PERMISSION ?? "null",
  )
  const boolean = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
  const flags = Effect.runSync(
    Config.all({
      plugins: boolean("OPENCODE_DISABLE_DEFAULT_PLUGINS"),
      skills: boolean("OPENCODE_DISABLE_EXTERNAL_SKILLS"),
      lspDownload: boolean("OPENCODE_DISABLE_LSP_DOWNLOAD"),
      claude: boolean("OPENCODE_DISABLE_CLAUDE_CODE"),
      claudePrompt: boolean("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"),
      claudeSkills: boolean("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"),
      autoShare: boolean("OPENCODE_AUTO_SHARE"),
    }),
  )
  return {
    pure: Flag.OPENCODE_PURE,
    projectConfig: Flag.OPENCODE_DISABLE_PROJECT_CONFIG,
    permission: Option.isSome(permission) ? permission.value : null,
    plugins: flags.plugins,
    skills: flags.skills,
    lspDownload: flags.lspDownload,
    claudePrompt: flags.claude || flags.claudePrompt,
    claudeSkills: flags.claude || flags.claudeSkills,
    autoShare: flags.autoShare,
    config: process.env.OPENCODE_CONFIG ? path.resolve(process.env.OPENCODE_CONFIG) : undefined,
    configDirectory: process.env.OPENCODE_CONFIG_DIR ? path.resolve(process.env.OPENCODE_CONFIG_DIR) : undefined,
    configContent: process.env.OPENCODE_CONFIG_CONTENT,
  }
}

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
        Flag.OPENCODE_PURE,
        process.env.OPENCODE_CONFIG ? path.resolve(process.env.OPENCODE_CONFIG) : undefined,
        process.env.OPENCODE_CONFIG_DIR ? path.resolve(process.env.OPENCODE_CONFIG_DIR) : undefined,
        process.env.OPENCODE_CONFIG_CONTENT,
        policy(),
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
  if (!(await secureDirectory(dir))) return undefined
  const file = await open(
    path.join(dir, "server.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!file) return undefined
  const text = await (async () => {
    try {
      const info = await file.stat()
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 16_384 ||
        (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
      ) {
        throw new Error("Unsafe daemon endpoint metadata")
      }
      return await file.readFile("utf8")
    } finally {
      await file.close()
    }
  })()
  const endpoint = Schema.decodeUnknownOption(Schema.fromJsonString(Endpoint))(text)
  if (Option.isNone(endpoint)) throw new Error(`Invalid daemon endpoint: ${path.join(dir, "server.json")}`)
  validateEndpoint(endpoint.value, dir)
  if (endpoint.value.socket) {
    const info = await lstat(endpoint.value.socket).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!info) return undefined
    if (!info.isSocket() || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) {
      throw new Error("Unsafe daemon socket")
    }
  }
  const client = connection(endpoint.value)
  // A stale TCP port can be rebound by another user. Prove knowledge of the
  // private discovery secret before sending reusable Basic credentials there.
  const nonce = endpoint.value.identity ? randomBytes(32).toString("hex") : undefined
  const response = await (client.fetch ?? fetch)(new URL("/__daemon/status", client.url), {
    headers: nonce
      ? { Authorization: `OpenCode ${nonce}:${proof(endpoint.value.password, nonce, "request")}` }
      : client.headers,
    signal: AbortSignal.timeout(1000),
    redirect: "error",
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
  if (nonce && response.headers.get("X-OpenCode-Proof") !== proof(endpoint.value.password, nonce, "response")) {
    throw new Error("OpenCode daemon failed server identity verification")
  }
  const status = Schema.decodeUnknownOption(Status)(await response.json())
  if (Option.isNone(status)) throw new Error("OpenCode daemon returned an invalid status")
  if (
    !Number.isSafeInteger(status.value.pid) ||
    status.value.pid <= 0 ||
    (endpoint.value.pid !== undefined && status.value.pid !== endpoint.value.pid)
  ) {
    throw new Error("OpenCode daemon returned an invalid identity")
  }
  return { ...client, status: status.value }
}

export async function ensure(dir = directory()) {
  await secureDirectory(dir, true)
  const current = await available(dir)
  if (current) return compatible(current)
  return Flock.withLock(
    "startup",
    async () => {
      const current = await available(dir)
      if (current) return compatible(current)
      const log = await open(
        path.join(dir, "server.log"),
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      )
      const source = /^(bun|node)(\.exe)?$/.test(path.basename(process.execPath))
      const child = spawn(
        process.execPath,
        [...(source ? [fileURLToPath(new URL("../index.ts", import.meta.url))] : []), "server", "--daemon"],
        {
          cwd: os.homedir(),
          env: {
            ...process.env,
            OPENCODE_DAEMON_DIR: dir,
            OPENCODE_DB: database(),
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
      try {
        while (Date.now() < deadline) {
          const ready = await available(dir)
          if (ready) return compatible(ready)
          if (failure || child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`OpenCode daemon failed to start. See ${path.join(dir, "server.log")}`, { cause: failure })
          }
          await Bun.sleep(50)
        }
        throw new Error(`Timed out starting OpenCode daemon. See ${path.join(dir, "server.log")}`)
      } catch (error) {
        child.kill("SIGTERM")
        throw error
      }
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
  if (client.status.stopping) throw new Error("OpenCode daemon is stopping; retry after shutdown")
  if (
    client.status.policy !== undefined
      ? client.status.policy !== policy()
      : Object.values(restrictions()).some(Boolean) ||
        !!process.env.OPENCODE_DB ||
        ["1", "true"].includes(process.env.OPENCODE_DISABLE_CHANNEL_DB ?? "")
  ) {
    throw new Error("OpenCode daemon has incompatible backend security/database policy. Run 'oc server stop' and retry.")
  }
  return client
}

async function available(dir: string) {
  const deadline = Date.now() + 30_000
  while (true) {
    const current = await read(dir)
    if (!current?.status.stopping) return current
    if (Date.now() >= deadline) throw new Error("Timed out waiting for stopping OpenCode daemon")
    await Bun.sleep(50)
  }
}

export async function secureDirectory(dir: string, create = false) {
  const resolved = path.resolve(dir)
  const parts = resolved.slice(path.parse(resolved).root.length).split(path.sep).filter(Boolean)
  if (!parts.length) throw new Error(`Unsafe daemon discovery directory: ${resolved}`)
  let current = path.parse(resolved).root
  for (const part of parts) {
    current = path.join(current, part)
    const info = await lstat(current).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      if (!create) return undefined
      await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
      })
      return lstat(current)
    })
    if (!info) return false
    // Root-owned sticky temp roots are safe boundaries. Every child below them
    // must be owned and non-writable by other users; never chmod hostile ancestry.
    if (
      !info.isDirectory() ||
      (process.getuid &&
        ((info.uid !== process.getuid() && info.uid !== 0) ||
          ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0 && current !== resolved)) ||
          (current === resolved && info.uid !== process.getuid())))
    ) throw new Error(`Unsafe daemon discovery directory: ${current}`)
  }
  if (create) await chmod(resolved, 0o700)
  const info = await lstat(resolved)
  if (process.getuid && (info.mode & 0o077) !== 0) {
    // Empty, owned directories may be hardened by ensure; metadata is never read
    // until the discovery leaf itself is private.
    if (!create) throw new Error(`Unsafe daemon discovery directory: ${resolved}`)
  }
  return true
}

function validateEndpoint(endpoint: typeof Endpoint.Type, dir?: string) {
  const url = new URL(endpoint.url)
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !endpoint.password ||
    (endpoint.socket
      ? url.origin !== "http://opencode.internal" || !dir || endpoint.socket !== path.join(path.resolve(dir), "server.sock")
      : !["127.0.0.1", "[::1]"].includes(url.hostname) || !url.port)
  ) {
    throw new Error("Unsafe daemon endpoint: expected an authenticated local listener")
  }
}

export async function request(client: Connection, action: string, body?: unknown) {
  const response = await (client.fetch ?? fetch)(new URL(`/__daemon/${action}`, client.url), {
    method: "POST",
    headers: { ...client.headers, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  })
  if (!response.ok) throw new Error(`Daemon ${action} failed: ${await response.text()}`)
  return response
}

export async function attach(client: Connection) {
  const response = await request(client, "listen")
  const endpoint = Schema.decodeUnknownOption(Endpoint)(await response.json())
  if (Option.isNone(endpoint)) throw new Error("OpenCode daemon returned an invalid attachment endpoint")
  validateEndpoint(endpoint.value)
  return { ...connection(endpoint.value), password: endpoint.value.password }
}

export * as Daemon from "./daemon"

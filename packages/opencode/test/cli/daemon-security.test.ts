import { expect, test } from "bun:test"
import path from "node:path"
import { chmod, link, mkdir, rm, symlink } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Daemon } from "../../src/cli/daemon"
import { tmpdir } from "../fixture/fixture"

test("discovery rejects hostile ancestry and metadata before contacting a listener", async () => {
  await using tmp = await tmpdir()
  const dir = path.join(tmp.path, "private")
  await mkdir(dir, { mode: 0o700 })
  const state = { requests: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      state.requests++
      return Response.json({ protocol: Daemon.protocol, version: "compatible", pid: process.pid, started: Date.now() })
    },
  })
  const file = path.join(dir, "server.json")
  const endpoint = { url: server.url.toString(), password: "private-test-secret" }
  try {
    await Bun.write(file, JSON.stringify(endpoint), { mode: 0o600 })
    await chmod(file, 0o600)
    await chmod(tmp.path, 0o777)
    await expect(Daemon.read(dir)).rejects.toThrow("Unsafe daemon discovery")
    await expect(Daemon.ensure(dir)).rejects.toThrow("Unsafe daemon discovery")
    expect(state.requests).toBe(0)
    await chmod(tmp.path, 0o755)
    const alias = path.join(tmp.path, "alias")
    await symlink(dir, alias)
    await expect(Daemon.read(alias)).rejects.toThrow("Unsafe daemon discovery")
    await expect(Daemon.ensure(alias)).rejects.toThrow("Unsafe daemon discovery")
    await chmod(file, 0o644)
    await expect(Daemon.read(dir)).rejects.toThrow("Unsafe daemon endpoint metadata")
    await chmod(file, 0o600)
    const saved = path.join(tmp.path, "saved.json")
    await link(file, saved)
    await expect(Daemon.read(dir)).rejects.toThrow("Unsafe daemon endpoint metadata")
    await rm(saved)
    await rm(file)
    expect(Bun.spawnSync(["mkfifo", "-m", "600", file]).exitCode).toBe(0)
    await expect(Daemon.read(dir)).rejects.toThrow("Unsafe daemon endpoint metadata")
    await rm(file)
    await Bun.write(file, JSON.stringify({ ...endpoint, password: "x".repeat(16_384) }), { mode: 0o600 })
    await expect(Daemon.read(dir)).rejects.toThrow("Unsafe daemon endpoint metadata")
    expect(state.requests).toBe(0)
    await rm(file)
    await Bun.write(file, "invalid-json")
    await chmod(file, 0o600)
    await expect(Daemon.read(dir)).rejects.toThrow("Invalid daemon endpoint")
    await rm(file)
    await Bun.write(saved, JSON.stringify(endpoint), { mode: 0o600 })
    await chmod(saved, 0o600)
    await symlink(saved, file)
    await expect(Daemon.read(dir)).rejects.toThrow()
    expect(state.requests).toBe(0)
    await rm(file)
    await Bun.write(file, JSON.stringify(endpoint), { mode: 0o600 })
    await chmod(file, 0o600)
    expect((await Daemon.read(dir))?.status.version).toBe("compatible")
    expect(state.requests).toBe(1)
  } finally {
    server.stop(true)
    await chmod(tmp.path, 0o755)
  }
})

test("discovery and attachment reject remote URLs, foreign sockets, redirects and mismatched identity", async () => {
  await using tmp = await tmpdir()
  await chmod(tmp.path, 0o700)
  const file = path.join(tmp.path, "server.json")
  const state = { requests: 0, redirect: false, attachment: false }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      state.requests++
      if (state.redirect) return Response.redirect("http://example.test/__daemon/status")
      if (state.attachment) return Response.json({ url: "http://example.test/", password: "secret" })
      return Response.json({ protocol: Daemon.protocol, version: "compatible", pid: process.pid, started: Date.now() })
    },
  })
  const write = async (endpoint: object) => {
    await Bun.write(file, JSON.stringify(endpoint), { mode: 0o600 })
    await chmod(file, 0o600)
  }
  try {
    for (const url of [
      "http://example.test/",
      "http://localhost:1234/",
      "https://127.0.0.1:1234/",
      "http://user:pass@127.0.0.1:1234/",
      `${server.url}other`,
      `${server.url}?query=1`,
    ]) {
      await write({ url, password: "secret" })
      await expect(Daemon.read(tmp.path)).rejects.toThrow("Unsafe daemon endpoint")
    }
    await write({ url: "http://opencode.internal", socket: path.join(tmp.path, "other.sock"), password: "secret" })
    await expect(Daemon.read(tmp.path)).rejects.toThrow("Unsafe daemon endpoint")
    expect(state.requests).toBe(0)
    await write({ url: server.url.toString(), password: "" })
    await expect(Daemon.read(tmp.path)).rejects.toThrow("Unsafe daemon endpoint")
    const socket = path.join(tmp.path, "server.sock")
    await symlink(file, socket)
    await write({ url: "http://opencode.internal", socket, password: "secret" })
    await expect(Daemon.read(tmp.path)).rejects.toThrow("Unsafe daemon socket")
    await write({ url: server.url.toString(), password: "secret", pid: process.pid + 1 })
    await expect(Daemon.read(tmp.path)).rejects.toThrow("invalid identity")
    await write({ url: server.url.toString(), password: "secret" })
    state.redirect = true
    await expect(Daemon.read(tmp.path)).rejects.toThrow("not responding")
    state.redirect = false
    state.attachment = true
    await expect(Daemon.attach(Daemon.connection({ url: server.url.toString(), password: "secret" }))).rejects.toThrow(
      "Unsafe daemon endpoint",
    )
  } finally {
    server.stop(true)
  }
})

test("a replacement listener must prove server identity without receiving reusable credentials", async () => {
  await using tmp = await tmpdir()
  await chmod(tmp.path, 0o700)
  const password = "private-discovery-password"
  const state = { honest: false, authorization: [] as string[] }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const authorization = request.headers.get("authorization") ?? ""
      state.authorization.push(authorization)
      const nonce = authorization.slice("OpenCode ".length).split(":")[0]
      return Response.json(
        { protocol: Daemon.protocol, version: "compatible", pid: process.pid, started: Date.now() },
        {
          // Reflecting the client's request proof must not authenticate the server.
          headers: {
            "X-OpenCode-Proof": state.honest ? Daemon.proof(password, nonce, "response") : authorization.split(":")[1],
          },
        },
      )
    },
  })
  try {
    await Bun.write(
      path.join(tmp.path, "server.json"),
      JSON.stringify({ url: server.url.toString(), password, pid: process.pid, identity: "hmac-sha256-v1" }),
    )
    await chmod(path.join(tmp.path, "server.json"), 0o600)
    await expect(Daemon.read(tmp.path)).rejects.toThrow("server identity verification")
    state.honest = true
    expect((await Daemon.read(tmp.path))?.status.pid).toBe(process.pid)
    expect(state.authorization).toHaveLength(2)
    expect(state.authorization[0]).not.toBe(state.authorization[1])
    state.authorization.forEach((value) => {
      expect(value).toStartWith("OpenCode ")
      expect(value).not.toContain(password)
      expect(value).not.toContain(Buffer.from(`opencode:${password}`).toString("base64"))
    })
  } finally {
    server.stop(true)
  }
})

test("a later restricted client cannot borrow an unrestricted backend or load its project plugin", async () => {
  await using first = await tmpdir()
  await using second = await tmpdir()
  await using project = await tmpdir({ git: true })
  const plugin = path.join(project.path, "policy-plugin.ts")
  const marker = path.join(project.path, "plugin-loaded")
  await Bun.write(
    plugin,
    `export default async ({ directory }) => { await Bun.write(directory + "/plugin-loaded", "loaded"); return {} }`,
  )
  await Bun.write(path.join(project.path, "opencode.json"), JSON.stringify({ plugin: [pathToFileURL(plugin).href] }))
  const unrestricted = await Daemon.ensure(first.path)
  try {
    await Daemon.request(unrestricted, "upgrade", { directory: project.path })
    expect(await Bun.file(marker).exists()).toBe(true)
    await rm(marker)
    const invoke = async (dir: string, reject: boolean) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
        import { Daemon } from "./src/cli/daemon.ts"
        const client = await Daemon.ensure()
        await Daemon.request(client, "upgrade", { directory: ${JSON.stringify(project.path)} })
        console.log(JSON.stringify(client.status))
      `,
        ],
        {
          cwd: path.resolve(import.meta.dir, "../.."),
          env: {
            ...process.env,
            OPENCODE_DAEMON_DIR: dir,
            OPENCODE_DISABLE_PROJECT_CONFIG: "1",
            OPENCODE_PERMISSION: '{"bash":"deny"}',
          },
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (reject) {
        expect(code).not.toBe(0)
        expect(stderr).toContain("incompatible backend security/database policy")
        return
      }
      expect(code, stderr).toBe(0)
      expect(JSON.parse(stdout).pid).not.toBe(unrestricted.status.pid)
    }
    await invoke(first.path, true)
    await invoke(second.path, false)
    expect(await Bun.file(marker).exists()).toBe(false)
    const restricted = await Daemon.read(second.path)
    if (!restricted) throw new Error("restricted daemon missing")
    const sdk = createOpencodeClient({
      baseUrl: restricted.url,
      fetch: restricted.fetch,
      headers: restricted.headers,
      directory: project.path,
      throwOnError: true,
    })
    expect((await sdk.config.get()).data?.permission).toMatchObject({ bash: "deny" })
  } finally {
    for (const dir of [first.path, second.path]) {
      const client = await Daemon.read(dir)
      if (client) await Daemon.request(client, "stop")
    }
  }
}, 40000)

test("explicit discovery reuse ignores client presentation state and build version but checks backend policy and DB", async () => {
  await using tmp = await tmpdir()
  const dir = tmp.path
  const database = path.join(dir, "shared.db")
  const invoke = async (settings: NodeJS.ProcessEnv = {}, rejected = false) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
        globalThis.OPENCODE_VERSION = process.env.TEST_CLIENT_VERSION ?? "first-client-build"
        const { Daemon } = await import("./src/cli/daemon.ts")
        const client = await Daemon.ensure()
        console.log(JSON.stringify({ status: client.status, policy: Daemon.policy() }))
      `,
      ],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: {
          ...process.env,
          OPENCODE_DAEMON_DIR: dir,
          OPENCODE_DB: database,
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "false",
          OPENCODE_DISABLE_CHANNEL_DB: "false",
          XDG_STATE_HOME: path.join(dir, "first-client-state"),
          ...settings,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (rejected) {
      expect(code).not.toBe(0)
      expect(stderr).toContain("incompatible backend security/database policy")
      return undefined
    }
    expect(code, stderr).toBe(0)
    return JSON.parse(stdout)
  }
  try {
    const first = await invoke()
    const backend = await Daemon.read(dir)
    if (!backend) throw new Error("shared backend missing")
    const sdk = createOpencodeClient({
      baseUrl: backend.url,
      fetch: backend.fetch,
      headers: backend.headers,
      directory: dir,
      throwOnError: true,
    })
    const session = await sdk.session.create({ title: "cross-state shared database" })
    if (!session.data) throw new Error("session creation failed")
    expect(await Bun.file(database).exists()).toBe(true)
    const other = await invoke({
      XDG_STATE_HOME: path.join(dir, "other-client-state"),
      TEST_CLIENT_VERSION: "compatible-other-client-build",
      OPENCODE_DISABLE_CHANNEL_DB: "true",
    })
    expect(other.status.pid).toBe(first.status.pid)
    expect(other.policy).toBe(first.policy)
    expect(other.status.protocol).toBe(Daemon.protocol)
    expect(other.status.version).not.toBe("compatible-other-client-build")
    expect((await sdk.session.list()).data?.some((item) => item.id === session.data?.id)).toBe(true)
    await invoke({ OPENCODE_DISABLE_DEFAULT_PLUGINS: "true" }, true)
    await invoke({ OPENCODE_DB: path.join(dir, "different.db") }, true)
    expect((await Daemon.read(dir))?.status.pid).toBe(first.status.pid)
    expect(await Bun.file(path.join(dir, "different.db")).exists()).toBe(false)
  } finally {
    const client = await Daemon.read(dir)
    if (client) await Daemon.request(client, "stop")
  }
}, 40000)

import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { stat } from "node:fs/promises"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Daemon } from "../../src/cli/daemon"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect, pollWithTimeout } from "../lib/effect"

const it = testEffect(NodeServices.layer)

it.live("concurrent thin clients share one detached daemon, projects and event streams", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const project = yield* tmpdirScoped({ git: true })
    const other = yield* tmpdirScoped({ git: true })
    yield* Effect.promise(async () => {
      const plugin = path.join(project, "daemon-plugin.ts")
      await Bun.write(
        plugin,
        `
        export const DaemonPlugin = async ({ client, directory }) => {
          return {
            event: async () => {
              const result = await client.project.list()
              await Bun.write(directory + "/plugin-health.txt", String(result.response.status))
            }
          }
        }
      `,
      )
      await Bun.write(path.join(project, "opencode.json"), JSON.stringify({ plugin: [pathToFileURL(plugin).href] }))
    })
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        const client = await Daemon.read(dir)
        if (client) await Daemon.request(client, "stop")
      }),
    )
    const clients = yield* Effect.promise(() =>
      Promise.all(
        [0, 1, 2].map(async () => {
          const child = Bun.spawn(
            [
              process.execPath,
              "-e",
              `
        import { Daemon } from "./src/cli/daemon.ts"
        const client = await Daemon.ensure()
        console.log(JSON.stringify(client.status))
      `,
            ],
            {
              cwd: path.resolve(import.meta.dir, "../.."),
              env: {
                ...process.env,
                OPENCODE_DAEMON_DIR: dir,
                OPENCODE_DISABLE_MODELS_FETCH: "1",
                OPENCODE_DISABLE_AUTOUPDATE: "1",
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
          expect(stderr).toBe("")
          expect(code).toBe(0)
          return Schema.decodeUnknownSync(Schema.fromJsonString(Daemon.Status))(stdout)
        }),
      ),
    )
    expect(new Set(clients.map((client) => client.pid)).size).toBe(1)
    const connection = yield* Effect.promise(() => Daemon.ensure(dir))
    expect(connection.status.pid).toBe(clients[0].pid)
    if (process.platform !== "win32") {
      expect(connection.fetch).toBeDefined()
      const permissions = yield* Effect.promise(() => stat(path.join(dir, "server.sock")))
      expect(permissions.mode & 0o777).toBe(0o600)
    }
    const sdk = createOpencodeClient({
      baseUrl: connection.url,
      fetch: connection.fetch,
      headers: connection.headers,
      directory: project,
      throwOnError: true,
    })
    const remote = createOpencodeClient({
      baseUrl: connection.url,
      fetch: connection.fetch,
      headers: connection.headers,
      directory: other,
      throwOnError: true,
    })
    yield* Effect.promise(() => Daemon.request(connection, "upgrade", { directory: project }))
    const session = yield* Effect.promise(() => sdk.session.create({ title: "shared daemon session" }))
    expect(session.data?.directory).toBe(project)
    const pluginHealth = yield* pollWithTimeout(
      Effect.promise(async () => {
        const file = Bun.file(path.join(project, "plugin-health.txt"))
        return (await file.exists()) ? file.text() : undefined
      }),
      "server plugin never authenticated its internal SDK client",
    ).pipe(
      Effect.tapError(() =>
        Effect.promise(async () => {
          process.stderr.write(await Bun.file(path.join(dir, "server.log")).text())
        }),
      ),
    )
    expect(pluginHealth).toBe("200")
    const second = yield* Effect.promise(() => remote.session.create({ title: "other project" }))
    expect(second.data?.directory).toBe(other)

    const abort = new AbortController()
    const events = yield* Effect.promise(() => sdk.global.event({ signal: abort.signal, sseMaxRetryAttempts: 0 }))
    const iterator = events.stream[Symbol.asyncIterator]()
    const event = yield* Effect.promise(() => iterator.next())
    expect(event.done).toBe(false)
    abort.abort()
    yield* Effect.promise(() => iterator.return?.().then(() => undefined) ?? Promise.resolve())

    // A lazy TCP attachment supports /split and existing external clients, but
    // it must use the same backend as the filesystem-socket client.
    const attachment = yield* Effect.promise(() => Daemon.attach(connection))
    const attached = createOpencodeClient({
      ...attachment,
      baseUrl: attachment.url,
      directory: project,
      throwOnError: true,
    })
    const existing = yield* Effect.promise(() => attached.session.list())
    expect(existing.data?.some((item) => item.id === session.data?.id)).toBe(true)
    expect(existing.data?.some((item) => item.id === second.data?.id)).toBe(false)

    const unauthorized = yield* Effect.promise(() =>
      (connection.fetch ?? fetch)(new URL("/__daemon/status", connection.url)),
    )
    expect(unauthorized.status).toBe(401)
    yield* Effect.promise(() => Daemon.request(connection, "stop"))
    yield* pollWithTimeout(
      Effect.promise(async () => (!(await Daemon.read(dir)) ? true : undefined)),
      "daemon never stopped",
    )
  }),
)

it.live("a crashed daemon is replaced without trusting its stale socket or endpoint", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        const client = await Daemon.read(dir)
        if (client) await Daemon.request(client, "stop")
      }),
    )
    const before = yield* Effect.promise(() => Daemon.ensure(dir))
    process.kill(before.status.pid, "SIGKILL")
    yield* pollWithTimeout(
      Effect.promise(async () => (!(await Daemon.read(dir)) ? true : undefined)),
      "crashed daemon still responds",
    )
    const after = yield* Effect.promise(() => Daemon.ensure(dir))
    expect(after.status.pid).not.toBe(before.status.pid)
    expect(after.status.started).toBeGreaterThan(before.status.started)
    yield* Effect.promise(() => Daemon.request(after, "stop"))
    yield* pollWithTimeout(
      Effect.promise(async () => (!(await Daemon.read(dir)) ? true : undefined)),
      "replacement never stopped",
    )
  }),
)

it.live("compatible older builds are reused and incompatible protocols are left intact", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const state = { protocol: Daemon.protocol }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json({ protocol: state.protocol, version: "older-build", pid: process.pid, started: Date.now() }),
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        server.stop(true)
      }),
    )
    yield* Effect.promise(() =>
      Bun.write(
        path.join(dir, "server.json"),
        JSON.stringify({
          url: server.url.toString(),
          password: "test-local-endpoint",
        }),
      ),
    )
    yield* Effect.promise(async () => {
      expect((await Daemon.ensure(dir)).status.version).toBe("older-build")
      state.protocol += 1
      await expect(Daemon.ensure(dir)).rejects.toThrow("incompatible")
      const existing = await Daemon.read(dir)
      expect(existing?.status.version).toBe("older-build")
      expect(existing?.status.pid).toBe(process.pid)
    })
  }),
)

it.live("server stop exits even when a server plugin is stuck during initialization", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const project = yield* tmpdirScoped({ git: true })
    yield* Effect.promise(async () => {
      const plugin = path.join(project, "stuck-plugin.ts")
      await Bun.write(
        plugin,
        `
        export default async ({ directory }) => {
          await Bun.write(directory + "/plugin-started.txt", "started")
          await new Promise(() => {})
          return {}
        }
      `,
      )
      await Bun.write(path.join(project, "opencode.json"), JSON.stringify({ plugin: [pathToFileURL(plugin).href] }))
    })
    const connection = yield* Effect.promise(() => Daemon.ensure(dir))
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        try {
          process.kill(connection.status.pid, "SIGKILL")
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return
          throw error
        }
      }),
    )
    const pending = Daemon.request(connection, "upgrade", { directory: project }).catch(() => undefined)
    yield* pollWithTimeout(
      Effect.promise(async () =>
        (await Bun.file(path.join(project, "plugin-started.txt")).exists()) ? true : undefined,
      ),
      "plugin never started",
    )
    const result = yield* Effect.promise(async () => {
      const child = Bun.spawn([process.execPath, "src/index.ts", "server", "stop"], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: { ...process.env, OPENCODE_DAEMON_DIR: dir },
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
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("background server stopped")
    yield* Effect.promise(() => pending)
    expect(yield* Effect.promise(() => Daemon.read(dir))).toBeUndefined()
  }),
)

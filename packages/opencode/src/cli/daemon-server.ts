import path from "node:path"
import { chmod, rename, rm } from "node:fs/promises"
import { timingSafeEqual } from "node:crypto"
import { Flock } from "@opencode-ai/core/util/flock"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Daemon } from "./daemon"
import { withTimeout } from "../util/timeout"

export async function run() {
  const dir = Daemon.directory()
  await Daemon.secureDirectory(dir, true)
  await using owner = await Flock.acquire("owner", {
    dir: path.join(dir, "locks"),
    staleMs: 5000,
    timeoutMs: 10_000,
    baseDelayMs: 50,
    maxDelayMs: 100,
  })
  if (await Daemon.read(dir)) return
  // Do not let readiness probes send a crashed server's credentials to the new
  // listener between binding its socket and publishing its new endpoint.
  await rm(path.join(dir, "server.json"), { force: true })
  const socket = process.platform === "win32" ? undefined : path.join(dir, "server.sock")
  if (socket) await rm(socket, { force: true })

  const password = process.env.OPENCODE_SERVER_PASSWORD
  if (!password) throw new Error("Daemon startup requires private credentials; use 'oc server start'")
  const authorization = Buffer.from(`Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`)
  const { Server } = await import("../server/server")
  const { InstanceRuntime } = await import("../project/instance-runtime")
  const { AppRuntime } = await import("../effect/app-runtime")
  const { HttpApiApp } = await import("../server/routes/instance/httpapi/server")
  const status = {
    protocol: Daemon.protocol,
    version: InstallationVersion,
    pid: process.pid,
    started: Date.now(),
    policy: Daemon.policy(),
  }
  let listener: Promise<Awaited<ReturnType<typeof Server.listen>>> | undefined
  let stopping = false
  let finish: () => void = () => {}
  const stopped = new Promise<void>((resolve) => {
    finish = resolve
  })
  const shutdown = () => {
    if (stopping) return
    stopping = true
    finish()
  }
  const upgrades = new Set<string>()
  // Bun's Unix option types omit the runtime-supported idleTimeout setting.
  const server = Bun.serve({
    ...(socket ? { unix: socket } : { hostname: "127.0.0.1", port: 0 }),
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const challenge =
        url.pathname === "/__daemon/status" && request.method === "GET"
          ? /^OpenCode ([a-f0-9]{64}):([a-f0-9]{64})$/.exec(request.headers.get("authorization") ?? "")
          : null
      const supplied = Buffer.from(request.headers.get("authorization") ?? "")
      const expected = challenge
        ? Buffer.from(`OpenCode ${challenge[1]}:${Daemon.proof(password, challenge[1], "request")}`)
        : authorization
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return new Response("Unauthorized", { status: 401 })
      }
      if (url.pathname === "/__daemon/status" && request.method === "GET")
        return Response.json(
          { ...status, stopping },
          {
            headers: challenge ? { "X-OpenCode-Proof": Daemon.proof(password, challenge[1], "response") } : undefined,
          },
        )
      if (stopping) return new Response("Daemon is stopping", { status: 503 })
      if (!url.pathname.startsWith("/__daemon/")) return Server.Default().app.fetch(request)
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
      if (url.pathname === "/__daemon/stop") {
        // Give the caller its response before closing active connections.
        stopping = true
        setTimeout(finish, 20)
        return Response.json({ stopped: true })
      }
      if (url.pathname === "/__daemon/listen") {
        const tcp = await (listener ??= Server.listen({ hostname: "127.0.0.1", port: 0, shared: true }).catch(
          (error) => {
            listener = undefined
            throw error
          },
        ))
        if (stopping) return new Response("Daemon is stopping", { status: 503 })
        return Response.json({ url: tcp.url.toString(), password })
      }
      if (url.pathname === "/__daemon/snapshot") {
        const { writeHeapSnapshot } = await import("node:v8")
        return Response.json(writeHeapSnapshot(path.join(dir, "server.heapsnapshot")))
      }
      if (url.pathname === "/__daemon/reload") {
        const { Config } = await import("../config/config")
        const { Effect } = await import("effect")
        const { disposeAllInstancesAndEmitGlobalDisposed } = await import("../server/global-lifecycle")
        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const config = yield* Config.Service
            yield* config.invalidate()
            yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
          }),
        )
        return Response.json({ reloaded: true })
      }
      if (url.pathname === "/__daemon/upgrade") {
        const body: unknown = await request.json()
        if (typeof body !== "object" || body === null || !("directory" in body) || typeof body.directory !== "string") {
          return new Response("Missing directory", { status: 400 })
        }
        if (!upgrades.has(body.directory)) {
          upgrades.add(body.directory)
          const { upgrade } = await import("./upgrade")
          await InstanceRuntime.load({ directory: body.directory })
          await upgrade().catch(() => {})
        }
        return Response.json({ checked: true })
      }
      return new Response("Not found", { status: 404 })
    },
  } as Parameters<typeof Bun.serve>[0])
  try {
    if (socket) await chmod(socket, 0o600)
    await Bun.write(
      path.join(dir, "server.json.tmp"),
      JSON.stringify({
        url: socket ? "http://opencode.internal" : server.url.toString(),
        socket,
        password,
        pid: process.pid,
        identity: "hmac-sha256-v1",
      }),
      { mode: 0o600 },
    )
    await chmod(path.join(dir, "server.json.tmp"), 0o600)
    await rename(path.join(dir, "server.json.tmp"), path.join(dir, "server.json"))
    process.on("SIGTERM", shutdown)
    process.on("SIGINT", shutdown)
    await stopped
  } finally {
    process.off("SIGTERM", shutdown)
    process.off("SIGINT", shutdown)
    server.stop(true)
    try {
      const cleanup = await Promise.allSettled([
        withTimeout(InstanceRuntime.disposeAllInstances(), 5000, "Background instance cleanup timed out"),
        withTimeout(
          (async () => {
            if (listener) await (await listener).stop(true)
          })(),
          5000,
          "Background listener cleanup timed out",
        ),
      ])
      const runtimes = await Promise.allSettled([
        withTimeout(HttpApiApp.webHandler().dispose(), 5000, "Background HTTP runtime cleanup timed out"),
        withTimeout(AppRuntime.dispose(), 5000, "Background app runtime cleanup timed out"),
      ])
      const failures = [...cleanup, ...runtimes].filter((result) => result.status === "rejected")
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Background server cleanup failed",
        )
    } finally {
      await rm(path.join(dir, "server.json"), { force: true })
      if (socket) await rm(socket, { force: true })
    }
  }
}

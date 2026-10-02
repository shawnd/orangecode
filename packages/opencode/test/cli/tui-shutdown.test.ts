import path from "path"
import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { withTimeout } from "../../src/util/timeout"

test("failed session validation releases the backend worker without a forced process exit", async () => {
  await using tmp = await tmpdir()
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "tui-invalid-session.ts"), tmp.path], {
    env: {
      ...process.env,
      XDG_DATA_HOME: path.join(tmp.path, "data"),
      XDG_STATE_HOME: path.join(tmp.path, "state"),
      XDG_CONFIG_HOME: path.join(tmp.path, "config"),
      OPENCODE_DB: path.join(tmp.path, "opencode.db"),
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_PURE: "true",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  try {
    const code = await withTimeout(child.exited, 10_000)
    const [stdout, stderr] = await output
    expect(code, stderr).toBe(1)
    expect(stdout).toContain("invalid-session handler returned")
    expect(stderr).toContain("Session not found")
  } finally {
    if (child.exitCode === null) child.kill()
  }
}, 15_000)

for (const failure of ["occupied", "invalid"] as const) {
  test(`TUI ${failure}-port startup rejects and releases its worker without forced exit`, async () => {
    await using tmp = await tmpdir()
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("original listener") })
    const port = failure === "occupied" ? listener.port : 65536
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "tui-invalid-session.ts"), tmp.path, String(port)],
      {
        env: {
          ...process.env,
          XDG_DATA_HOME: path.join(tmp.path, "data"),
          XDG_STATE_HOME: path.join(tmp.path, "state"),
          XDG_CONFIG_HOME: path.join(tmp.path, "config"),
          XDG_CACHE_HOME: path.join(tmp.path, "cache"),
          OPENCODE_DB: path.join(tmp.path, "opencode.db"),
          OPENCODE_DISABLE_MODELS_FETCH: "true",
          OPENCODE_DISABLE_AUTOUPDATE: "true",
          OPENCODE_PURE: "true",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    try {
      const code = await withTimeout(child.exited, 10_000)
      const [stdout, stderr] = await output
      expect(code, stderr).toBe(1)
      expect(stdout, stderr).toContain("startup failure rejected")
      expect(stderr).toContain(failure === "occupied" ? "EADDRINUSE" : "port")
      expect(stderr).not.toContain("startup timed out")
      expect(await fetch(listener.url).then((response) => response.text())).toBe("original listener")
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
      await listener.stop(true)
    }
    const rebound = Bun.serve({ hostname: "127.0.0.1", port: listener.port, fetch: () => new Response("rebound") })
    await rebound.stop(true)
  }, 15_000)
}

for (const mode of ["normal", "stuck"] as const) {
  test(`TUI worker ${mode} lifecycle awaits cleanup and releases its actual listener`, async () => {
    await using tmp = await tmpdir()
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const port = probe.port
    const ready = Promise.withResolvers<void>()
    const observer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        ready.resolve()
        return new Response()
      },
    })
    await probe.stop(true)
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "tui-worker-lifecycle.ts"),
        mode,
        String(port),
        observer.url.toString(),
      ],
      {
        env: {
          ...process.env,
          XDG_DATA_HOME: path.join(tmp.path, "data"),
          XDG_STATE_HOME: path.join(tmp.path, "state"),
          XDG_CONFIG_HOME: path.join(tmp.path, "config"),
          XDG_CACHE_HOME: path.join(tmp.path, "cache"),
          OPENCODE_DB: path.join(tmp.path, "opencode.db"),
          OPENCODE_DISABLE_MODELS_FETCH: "true",
          OPENCODE_DISABLE_AUTOUPDATE: "true",
          OPENCODE_PURE: "true",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    try {
      if (mode === "stuck") {
        await withTimeout(ready.promise, 5000, "stuck fixture never bound")
        expect(await fetch(`http://127.0.0.1:${port}`).then((response) => response.text())).toBe(
          "stuck worker listener",
        )
      }
      const code = await withTimeout(child.exited, 10_000)
      const [stdout, stderr] = await output
      expect(code, stderr).toBe(0)
      expect(stdout, stderr).toContain(
        mode === "stuck" ? "stuck startup rejected after cleanup" : "worker shutdown awaited",
      )
      // Natural child exit and a successful rebind verify worker and socket cleanup, not just a caught error.
      const rebound = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("rebound") })
      await rebound.stop(true)
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
      await observer.stop(true)
    }
  }, 15_000)
}

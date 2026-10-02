import path from "path"
import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { withTimeout } from "../../src/util/timeout"
import { stopWorker } from "../../src/cli/cmd/tui"

test("shutdown waits for in-flight warmup before disposing the backend", async () => {
  const warming = Promise.withResolvers<void>()
  const calls: string[] = []
  const stop = stopWorker({
    warming: warming.promise,
    shutdown: async () => {
      calls.push("shutdown")
    },
    terminate: async () => {
      calls.push("terminate")
    },
  })
  await Promise.resolve()
  expect(calls).toEqual([])
  warming.resolve()
  await withTimeout(stop, 1000)
  expect(calls).toEqual(["shutdown", "terminate"])
})

test("worker termination still runs when startup warmup fails", async () => {
  const calls: string[] = []
  await stopWorker({
    warming: Promise.reject(new Error("warmup failed")),
    shutdown: async () => {
      calls.push("shutdown")
    },
    terminate: async () => {
      calls.push("terminate")
    },
  })
  expect(calls).toEqual(["terminate"])
})

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

import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"

test("daemon identity normalizes effective native executor settings and respects explicit profiles", async () => {
  await using tmp = await tmpdir()
  const profile = async (
    enabled?: string,
    workers?: string,
    explicit?: string,
    policies?: { idle?: string; release?: string },
  ) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tmp.path,
      XDG_STATE_HOME: `${tmp.path}/state`,
      XDG_DATA_HOME: `${tmp.path}/data`,
      XDG_CONFIG_HOME: `${tmp.path}/config`,
      XDG_CACHE_HOME: `${tmp.path}/cache`,
    }
    delete env.OPENCODE_DAEMON_DIR
    delete env.OPENCODE_EXPERIMENTAL_FFF_WORKER
    delete env.OPENCODE_FFF_WORKERS
    delete env.OPENCODE_EXPERIMENTAL_SEARCH_IDLE_MS
    delete env.OPENCODE_EXPERIMENTAL_JOB_OUTPUT_RELEASE
    if (enabled !== undefined) env.OPENCODE_EXPERIMENTAL_FFF_WORKER = enabled
    if (workers !== undefined) env.OPENCODE_FFF_WORKERS = workers
    if (explicit !== undefined) env.OPENCODE_DAEMON_DIR = explicit
    if (policies?.idle !== undefined) env.OPENCODE_EXPERIMENTAL_SEARCH_IDLE_MS = policies.idle
    if (policies?.release !== undefined) env.OPENCODE_EXPERIMENTAL_JOB_OUTPUT_RELEASE = policies.release
    const child = Bun.spawn(
      [process.execPath, "-e", 'import { Daemon } from "./src/cli/daemon.ts"; console.log(Daemon.directory())'],
      {
        cwd: new URL("../..", import.meta.url).pathname,
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stderr).toBe(0)
    return stdout.trim()
  }
  const direct = await profile()
  for (const setting of ["0", "false", "invalid"]) expect(await profile(setting, "8")).toBe(direct)
  const parallel = await profile("1")
  expect(parallel).not.toBe(direct)
  expect(await profile("true", "02")).toBe(parallel)
  expect(await profile("1", "invalid")).toBe(parallel)
  expect(await profile("1", "1")).not.toBe(parallel)
  expect(await profile("1", "8")).not.toBe(parallel)
  expect(await profile("1", "8", tmp.path)).toBe(tmp.path)
  for (const idle of ["0", "-1", "invalid", "2147483648"])
    expect(await profile(undefined, undefined, undefined, { idle })).toBe(direct)
  const retired = await profile(undefined, undefined, undefined, { idle: "1000" })
  expect(retired).not.toBe(direct)
  expect(await profile(undefined, undefined, undefined, { idle: "01000" })).toBe(retired)
  const released = await profile(undefined, undefined, undefined, { release: "1" })
  expect(released).not.toBe(direct)
  expect(await profile(undefined, undefined, undefined, { release: "true" })).toBe(released)
  expect(await profile(undefined, undefined, undefined, { release: "false" })).toBe(direct)
  expect(await profile("1", "8", tmp.path, { idle: "1000", release: "1" })).toBe(tmp.path)
}, 30000)

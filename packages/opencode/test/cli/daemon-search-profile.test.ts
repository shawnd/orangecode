import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"

test("daemon identity normalizes effective native executor settings and respects explicit profiles", async () => {
  await using tmp = await tmpdir()
  const profile = async (enabled?: string, workers?: string, explicit?: string) => {
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
    if (enabled !== undefined) env.OPENCODE_EXPERIMENTAL_FFF_WORKER = enabled
    if (workers !== undefined) env.OPENCODE_FFF_WORKERS = workers
    if (explicit !== undefined) env.OPENCODE_DAEMON_DIR = explicit
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
}, 30000)

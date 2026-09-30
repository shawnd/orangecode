import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"

const directory = `/tmp/opencode/server-jobs-${process.pid}`
await mkdir(directory, { recursive: true })
process.env.XDG_DATA_HOME = path.join(directory, "data")
process.env.XDG_CONFIG_HOME = path.join(directory, "config")
process.env.XDG_CACHE_HOME = path.join(directory, "cache")
process.env.XDG_STATE_HOME = path.join(directory, "state")
process.env.OPENCODE_TEST_HOME = path.join(directory, "home")
process.env.HOME = path.join(directory, "home")
process.env.XDG_RUNTIME_DIR = path.join(directory, "runtime")
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "true"
process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "true"
process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true"
process.env.OPENCODE_DISABLE_CLAUDE_CODE = "true"
process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = path.join(directory, "managed")
process.env.OPENCODE_MODELS_PATH = path.resolve("test/tool/fixtures/models-api.json")
process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"
process.env.OPENCODE_DB = ":memory:"

const { Clock, Duration, Effect } = await import("effect")
const { BackgroundJob } = await import("@/background/job")
const { BackgroundShell } = await import("@/background/shell")
const { LayerNode } = await import("@opencode-ai/core/effect/layer-node")
const { CrossSpawnSpawner } = await import("@opencode-ai/core/cross-spawn-spawner")
const { provideTmpdirInstance } = await import("../test/fixture/fixture")
const { AppRuntime } = await import("@/effect/app-runtime")

const pss = async () =>
  Number((await Bun.file(`/proc/${process.pid}/smaps_rollup`).text()).match(/^Pss:\s+(\d+)/m)?.[1])
const counters = async () => {
  const status = await Bun.file(`/proc/${process.pid}/status`).text()
  return {
    cpu: process.cpuUsage(),
    pssKiB: await pss(),
    voluntary: Number(status.match(/^voluntary_ctxt_switches:\s+(\d+)/m)?.[1]),
  }
}
const elapsed = (start: number) => performance.now() - start
let timerSleeps = 0
let timerWakes = 0
const measure = Effect.gen(function* () {
  const jobs = yield* BackgroundJob.Service
  const shells = yield* BackgroundShell.Service
  const cwd = directory
  const before = yield* Effect.promise(counters)
  const start = performance.now()
  let updates = 0
  let completions = 0
  const infos = yield* Effect.forEach(
    Array.from({ length: 200 }),
    (_, index) =>
      shells.start({
        sessionID: "bench",
        ancestors: [],
        shell: "/bin/bash",
        cwd,
        env: { PATH: process.env.PATH },
        command: `"${process.execPath}" -e 'await Bun.sleep(30);process.stdout.end("job-${index} needle\\n"+"x".repeat(30000)+"\\n")'`,
        onUpdate: () =>
          Effect.sync(() => {
            updates++
            return true
          }),
        onComplete: () =>
          Effect.sync(() => {
            completions++
          }),
      }),
    { concurrency: 8 },
  )
  yield* Effect.forEach(infos, (info) => jobs.wait({ id: info.id }))
  yield* Effect.sleep(300)
  const shortMs = elapsed(start)
  const retained = yield* Effect.promise(counters)
  const listStart = performance.now()
  const list = yield* jobs.list()
  const listMs = elapsed(listStart)
  const shellListStart = performance.now()
  const shellList = yield* shells.list("bench")
  const shellListMs = elapsed(shellListStart)
  const idle = yield* Effect.forEach(
    Array.from({ length: 40 }),
    () =>
      shells.start({
        sessionID: "bench",
        ancestors: [],
        shell: "/bin/bash",
        cwd,
        env: { PATH: process.env.PATH },
        command: "cat",
        stdin: true,
        onUpdate: () =>
          Effect.sync(() => {
            updates++
            return true
          }),
      }),
    { concurrency: 8 },
  )
  yield* Effect.sleep(300)
  const idleBefore = yield* Effect.promise(counters)
  const updatesBefore = updates
  const sleepsBefore = timerSleeps
  const wakesBefore = timerWakes
  yield* Effect.sleep(3000)
  const idleAfter = yield* Effect.promise(counters)
  const idleCallbacks = updates - updatesBefore
  const idleTimerSleeps = timerSleeps - sleepsBefore
  const idleTimerWakes = timerWakes - wakesBefore
  const burstStart = performance.now()
  const burst = idle[0]
  yield* Effect.forEach(Array.from({ length: 100 }), (_, i) =>
    shells.input("bench", burst.id, `burst-${i} needle\n${"x".repeat(4096)}\n`),
  )
  yield* shells.input("bench", burst.id, "", true)
  yield* jobs.wait({ id: burst.id })
  const burstMs = elapsed(burstStart)
  const search = yield* shells.output({ sessionID: "bench", id: infos[0].id, query: "needle" })
  const cancelStart = performance.now()
  yield* Effect.forEach(idle.slice(1), (info) => shells.cancel("bench", info.id), { concurrency: 8 })
  const result = {
    arm: process.env.JOBS_ARM ?? "changed",
    outputRelease: process.env.OPENCODE_EXPERIMENTAL_JOB_OUTPUT_RELEASE === "1",
    before,
    retained,
    shortMs,
    listMs,
    shellListMs,
    returnedPayloadBytes: list.reduce((n, info) => n + (info.output?.length ?? 0), 0),
    shellPayloadBytes: shellList.reduce((n, info) => n + info.output.length, 0),
    completions,
    updates,
    idleCallbacks,
    idleTimerSleeps,
    idleTimerWakes,
    idleBefore,
    idleAfter,
    idleCpuUs: idleAfter.cpu.user + idleAfter.cpu.system - idleBefore.cpu.user - idleBefore.cpu.system,
    idleWakeProxy: idleAfter.voluntary - idleBefore.voluntary,
    burstMs,
    cancelMs: elapsed(cancelStart),
    logRetrieval: search.lines.length,
    memory: process.memoryUsage(),
  }
  if (search.lines.length !== 1 || completions !== 200 || result.shellPayloadBytes !== 6_000_000)
    throw new Error("Workload did not deliver expected output/completions")
  const files = [
    "packages/core/src/background-job.ts",
    "packages/opencode/src/background/job.ts",
    "packages/opencode/src/background/shell.ts",
    "packages/opencode/src/tool/shell.ts",
    "packages/opencode/src/effect/runtime-flags.ts",
  ]
  const root = path.resolve("../..")
  const sources = yield* Effect.promise(() =>
    Promise.all(
      files.map(async (file) => {
        const contents =
          result.arm === "baseline" && file !== "packages/opencode/src/effect/runtime-flags.ts"
            ? execFileSync("git", ["show", `8998bdb660d66c31a6e390c1195867b6c303c781:${file}`], { cwd: root })
            : await Bun.file(path.join(root, file)).arrayBuffer()
        return [file, createHash("sha256").update(new Uint8Array(contents)).digest("hex")]
      }),
    ),
  )
  const record = {
    ...result,
    provenance: {
      baseline: "8998bdb660d66c31a6e390c1195867b6c303c781",
      bun: Bun.version,
      sources: Object.fromEntries(sources),
      harness: createHash("sha256")
        .update(yield* Effect.promise(() => Bun.file(import.meta.path).text()))
        .digest("hex"),
    },
  }
  if (process.env.JOBS_OUTPUT)
    yield* Effect.promise(() => Bun.write(process.env.JOBS_OUTPUT!, JSON.stringify(record, null, 2)))
  console.log(JSON.stringify(record))
})

try {
  await Effect.runPromise(
    Effect.gen(function* () {
      const clock = yield* Clock.Clock
      yield* Effect.scoped(
        provideTmpdirInstance(() => measure).pipe(
          Effect.provide(
            LayerNode.compile(LayerNode.group([BackgroundShell.node, BackgroundJob.node, CrossSpawnSpawner.node])),
          ),
          Effect.provideService(Clock.Clock, {
            currentTimeMillis: clock.currentTimeMillis,
            currentTimeNanos: clock.currentTimeNanos,
            currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
            currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
            sleep: (duration) =>
              Duration.toMillis(duration) === 200
                ? Effect.sync(() => {
                    timerSleeps++
                  }).pipe(
                    Effect.andThen(clock.sleep(duration)),
                    Effect.tap(() =>
                      Effect.sync(() => {
                        timerWakes++
                      }),
                    ),
                  )
                : clock.sleep(duration),
          }),
        ),
      )
    }),
  )
} finally {
  await AppRuntime.dispose()
  await rm(directory, { recursive: true, force: true })
}

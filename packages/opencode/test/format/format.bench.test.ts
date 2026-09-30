import { NodeFileSystem } from "@effect/platform-node"
import { expect, spyOn } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { Format } from "../../src/format"
import { biome, oxfmt, prettier, rlang } from "../../src/format/formatter"
import { Filesystem } from "../../src/util/filesystem"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Opt-in: run separately so discovery spies cannot affect other format tests.
if (process.env.OPENCODE_BENCH_FORMATTERS === "1") {
  const it = testEffect(
    Layer.mergeAll(LayerNode.compile(LayerNode.group([Format.node, CrossSpawnSpawner.node])), NodeFileSystem.layer),
  )

  it.live(
    "benchmark actual Format service discovery",
    () =>
      Effect.gen(function* () {
        for (const workload of ["missing-config", "missing-dependency", "process-probe"] as const) {
          for (const concurrency of [1, 120]) {
            for (let trial = 0; trial < 6; trial++) {
              yield* provideTmpdirInstance(
                (directory) =>
                  Effect.gen(function* () {
                    const fmt = yield* Format.Service
                    if (workload === "missing-dependency") {
                      yield* Effect.promise(() => Bun.write(`${directory}/package.json`, "{}"))
                    }
                    const files = Array.from(
                      { length: 24 },
                      (_, i) => `${directory}/file-${i}.${workload === "process-probe" ? "R" : "ts"}`,
                    )
                    yield* Effect.promise(() => Promise.all(files.map((file) => Bun.write(file, "x"))))
                    yield* fmt.init()

                    const discovery = [prettier, biome, oxfmt].map((item) => spyOn(item, "enabled"))
                    const findUp = spyOn(Filesystem, "findUp")
                    const readJson = spyOn(Filesystem, "readJson")
                    // Model a present executable whose capability probe rejects it.
                    // The service and the child process are real; only executable discovery is controlled.
                    const probe = spyOn(rlang, "enabled").mockImplementation(async () => {
                      await Bun.spawn(["/bin/false"], { stdout: "ignore", stderr: "ignore" }).exited
                      return false
                    })
                    yield* Effect.addFinalizer(() =>
                      Effect.sync(() => {
                        discovery.forEach((spy) => spy.mockRestore())
                        findUp.mockRestore()
                        readJson.mockRestore()
                        probe.mockRestore()
                      }),
                    )

                    const start = performance.now()
                    const result = yield* Effect.forEach(
                      Array.from({ length: 5 }).flatMap(() => files),
                      (file) => fmt.file(file),
                      { concurrency },
                    )
                    const elapsedMs = performance.now() - start
                    expect(result.every((value) => value === false)).toBe(true)
                    const searches = findUp.mock.calls.filter((args) => args[1] === directory)
                    // Fixture is a git root: each findUp has one directory and one target.
                    expect(searches.every((args) => args[2] === directory)).toBe(true)
                    console.log(
                      JSON.stringify({
                        workload,
                        concurrency,
                        trial,
                        warmup: trial === 0,
                        files: files.length,
                        requests: result.length,
                        elapsedMs,
                        discoveryCalls:
                          discovery.reduce((sum, spy) => sum + spy.mock.calls.length, 0) + probe.mock.calls.length,
                        findUpCalls: searches.length,
                        existenceProbes: searches.length,
                        configReads: readJson.mock.calls.filter((args) => args[0] === `${directory}/package.json`)
                          .length,
                        processProbes: probe.mock.calls.length,
                      }),
                    )
                  }).pipe(Effect.scoped),
                { git: true, config: { formatter: true } },
              )
            }
          }
        }
      }),
    120_000,
  )
}

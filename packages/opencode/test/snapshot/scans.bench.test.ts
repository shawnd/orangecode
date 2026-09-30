import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Snapshot } from "../../src/snapshot"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const commands: string[][] = []
const observed = Layer.effect(
  AppProcess.Service,
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    return AppProcess.Service.of({
      ...process,
      run: (command, options) =>
        Effect.suspend(() => {
          if (command._tag === "StandardCommand") commands.push([command.command, ...command.args])
          return process.run(command, options)
        }),
    })
  }),
).pipe(Layer.provide(LayerNode.compile(AppProcess.node)))

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node, CrossSpawnSpawner.node]), [
      [AppProcess.node, observed],
    ]),
    testInstanceStoreLayer,
  ),
)

// Pass the completion tree before and after the runtime change: the baseline's
// one-argument implementation ignores the extra argument at the JS boundary.
const bench = process.env.SNAPSHOT_SCANS_OUTPUT ? it.live : it.live.skip
bench(
  "real Snapshot completion sequence: escalating worktree scans",
  () =>
    Effect.gen(function* () {
      const results: {
        count: number
        workload: string
        trial: number
        trackMs: number
        patchMs: number
        totalMs: number
        commands: string[][]
        commandCount: number
        scans: number
        stages: number
      }[] = []
      for (const count of [100, 1_000, 10_000]) {
        yield* provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              const fs = yield* FSUtil.Service
              const snapshot = yield* Snapshot.Service
              yield* Effect.forEach(
                Array.from({ length: count }, (_, i) => i),
                (i) => fs.writeWithDirs(`${dir}/files/${String(i).padStart(6, "0")}.txt`, `file ${i}\noriginal\n`),
                { concurrency: 16 },
              )
              expect(yield* snapshot.track()).toBeTruthy()
              for (const workload of ["no-edit", "small-edit"]) {
                for (let trial = -2; trial < 7; trial++) {
                  const before = yield* snapshot.track()
                  if (!before) throw new Error("baseline tree missing")
                  if (workload === "small-edit") {
                    yield* fs.writeFileString(`${dir}/files/000000.txt`, `file 0\nedit ${trial}\n`)
                  }
                  commands.length = 0
                  const start = performance.now()
                  const completed = yield* snapshot.track()
                  const tracked = performance.now()
                  const patch: (hash: string, completed?: string) => Effect.Effect<Snapshot.Patch> = snapshot.patch
                  const result = yield* patch(before, completed)
                  const end = performance.now()
                  expect(completed).toBeTruthy()
                  expect(result.hash).toBe(before)
                  expect(result.files).toHaveLength(workload === "no-edit" ? 0 : 1)
                  if (trial < 0) continue
                  results.push({
                    count,
                    workload,
                    trial,
                    trackMs: tracked - start,
                    patchMs: end - tracked,
                    totalMs: end - start,
                    commands: [...commands],
                    commandCount: commands.length,
                    scans: commands.filter((args) => args.includes("diff-files") || args.includes("ls-files")).length,
                    stages: commands.filter((args) => args.includes("add")).length,
                  })
                }
              }
            }),
          { git: true },
        ).pipe(Effect.scoped)
      }
      const output = process.env.SNAPSHOT_SCANS_OUTPUT
      if (!output) throw new Error("SNAPSHOT_SCANS_OUTPUT missing")
      yield* Effect.promise(() =>
        Bun.write(
          output,
          JSON.stringify(
            {
              baseline: "e6f0f15a59125fb1775dd081da144ec16c4622aa",
              warmups: 2,
              samples: 7,
              bun: Bun.version,
              platform: process.platform,
              results,
            },
            null,
            2,
          ),
        ),
      )
    }),
  120_000,
)

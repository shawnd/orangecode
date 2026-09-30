import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import { Snapshot } from "../../src/snapshot"
import { TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node])), testInstanceStoreLayer),
)

console.log(JSON.stringify({ lockWaitAndStartupMs: Date.now() - Number(process.env.BENCH_REQUESTED_AT) }))

for (const fixture of [
  { name: "large-tracked", files: 1, lines: 100_000 },
  { name: "many-tracked", files: 120, lines: 2_000 },
]) {
  it.instance(
    fixture.name,
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fs = yield* FSUtil.Service
      const snapshot = yield* Snapshot.Service
      const original = Array.from(
        { length: fixture.lines },
        (_, i) => `${i.toString().padStart(8, "0")} ${"x".repeat(70)}\n`,
      ).join("")
      const modified = original.replace(
        `${Math.floor(fixture.lines / 2)
          .toString()
          .padStart(8, "0")} `,
        "changed! ",
      )
      for (let i = 0; i < fixture.files; i++) {
        yield* fs.writeFileString(`${instance.directory}/file-${i.toString().padStart(4, "0")}.txt`, original)
      }
      yield* Effect.promise(async () => {
        const proc = Bun.spawn(["git", "add", "."], { cwd: instance.directory, stdout: "ignore", stderr: "pipe" })
        expect(await proc.exited).toBe(0)
      })
      const before = yield* snapshot.track()
      expect(before).toBeTruthy()
      for (let i = 0; i < fixture.files; i++) {
        yield* fs.writeFileString(`${instance.directory}/file-${i.toString().padStart(4, "0")}.txt`, modified)
      }
      const after = yield* snapshot.track()
      expect(after).toBeTruthy()
      if (!before || !after) throw new Error("Missing snapshot")
      const samples = []
      for (let trial = 0; trial < 4; trial++) {
        Bun.gc(true)
        const rssBefore = process.memoryUsage().rss
        const start = performance.now()
        const diffs = yield* snapshot.diffFull(before, after)
        const wallMs = performance.now() - start
        expect(diffs).toHaveLength(fixture.files)
        expect(diffs.every((diff) => diff.additions === 1 && diff.deletions === 1)).toBe(true)
        samples.push({
          trial,
          warmup: trial === 0,
          wallMs,
          patchBytes: diffs.reduce((sum, diff) => sum + Buffer.byteLength(diff.patch ?? ""), 0),
          jsonBytes: Buffer.byteLength(JSON.stringify(diffs)),
          rssBefore,
          rssAfter: process.memoryUsage().rss,
          processMaxRssKiB: process.resourceUsage().maxRSS,
        })
      }
      const output = { fixture, inputBytes: Buffer.byteLength(original) * fixture.files, samples }
      console.log(JSON.stringify(output))
      if (process.env.SNAPSHOT_SIZE_RESULTS) {
        yield* fs.writeFileString(
          `${process.env.SNAPSHOT_SIZE_RESULTS}/${fixture.name}.json`,
          JSON.stringify(output, null, 2) + "\n",
        )
      }
    }),
    { git: true },
    120_000,
  )
}

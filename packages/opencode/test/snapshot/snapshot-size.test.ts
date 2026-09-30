import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { Effect, Layer } from "effect"
import { applyPatch } from "diff"
import path from "path"
import { InstanceState } from "../../src/effect/instance-state"
import { Snapshot } from "../../src/snapshot"
import { normalize, selectionPreview, text } from "../../../session-ui/src/components/session-diff"
import { TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node])), testInstanceStoreLayer),
)
const stage = (cwd: string) =>
  Effect.promise(async () => {
    const proc = Bun.spawn(["git", "add", "."], { cwd, stdout: "ignore", stderr: "pipe" })
    expect(await proc.exited).toBe(0)
  })

it.instance(
  "diffFull keeps machine-readable blank context despite Git presentation preferences",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const ctx = yield* InstanceState.context
      const fs = yield* FSUtil.Service
      const snapshot = yield* Snapshot.Service
      const gitdir = path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))
      const original = "first\n\nold\n\nlast\n"
      const modified = "first\n\nnew\n\nlast\n"
      const padding = "unchanged\n".repeat(20_000)
      yield* fs.writeFileString(`${instance.directory}/small.txt`, original)
      yield* fs.writeFileString(`${instance.directory}/large.txt`, original + padding)
      const before = yield* snapshot.track()
      yield* fs.writeFileString(`${instance.directory}/small.txt`, modified)
      yield* fs.writeFileString(`${instance.directory}/large.txt`, modified + padding)
      const after = yield* snapshot.track()
      if (!before || !after) throw new Error("Missing snapshot")
      yield* fs.writeFileString(
        path.join(gitdir, "config"),
        (yield* fs.readFileString(path.join(gitdir, "config"))) + "\n[diff]\n\tsuppressBlankEmpty = true\n",
      )
      const native = (options: string[]) =>
        Effect.promise(async () => {
          const proc = Bun.spawn(
            ["git", "--git-dir", gitdir, "diff", "--no-color", ...options, before, after, "--", "small.txt"],
            {
              cwd: instance.directory,
              stdout: "pipe",
              stderr: "pipe",
            },
          )
          const output = await new Response(proc.stdout).text()
          expect(await proc.exited).toBe(0)
          return output
        })
      // Prove the setting is active and custom indicators are supported CLI options.
      expect(yield* native([])).toContain("\n first\n\n-old\n+new\n\n last\n")
      expect(
        yield* native(["--output-indicator-new=>", "--output-indicator-old=<", "--output-indicator-context=."]),
      ).toContain("\n.first\n\n<old\n>new\n\n.last\n")
      const diffs = yield* snapshot.diffFull(before, after)
      expect(diffs).toHaveLength(2)
      for (const diff of diffs) {
        const suffix = diff.file === "large.txt" ? padding : ""
        expect(diff).toMatchObject({ additions: 1, deletions: 1 })
        const view = normalize({ ...diff, file: diff.file ?? "" })
        expect(view.fileDiff.isPartial).toBe(diff.file === "large.txt")
        expect(selectionPreview(view, { start: 2, end: 3 })).toBe("\nnew")
        expect(selectionPreview(view, { start: 2, end: 3, side: "deletions" })).toBe("\nold")
        if (!suffix) {
          expect(text(view, "deletions")).toBe(original)
          expect(text(view, "additions")).toBe(modified)
        }
        expect(diff.patch).toContain("\n first\n \n-old\n+new\n \n last\n")
        expect(applyPatch(original + suffix, diff.patch ?? "")).toBe(modified + suffix)
      }
      // Snapshot's override must not alter this repository's ordinary Git output.
      expect(yield* native([])).toContain("\n first\n\n-old\n+new\n\n last\n")
    }),
  { git: true },
)

it.instance(
  "diffFull bounds large tracked context and preserves historical contents and line selections",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fs = yield* FSUtil.Service
      const snapshot = yield* Snapshot.Service
      const file = "large tracked.txt"
      const original =
        Array.from({ length: 40_000 }, (_, i) => `${i}: ${"x".repeat(75)}\n`).join("") + "no final newline"
      const modified = original
        .replace("0: ", "first: ")
        .replace("20000: ", "وسط🙂: ")
        .replace("no final newline", "last")
      yield* fs.writeFileString(`${instance.directory}/${file}`, original)
      yield* stage(instance.directory)
      const before = yield* snapshot.track()
      yield* fs.writeFileString(`${instance.directory}/${file}`, modified)
      const after = yield* snapshot.track()
      if (!before || !after) throw new Error("Missing snapshot")
      const diffs = yield* snapshot.diffFull(before, after)
      expect(diffs).toHaveLength(1)
      const diff = diffs[0]
      expect(diff).toMatchObject({ file, additions: 3, deletions: 3, status: "modified" })
      expect(Buffer.byteLength(diff.patch ?? "")).toBeLessThan(3_000)
      expect(applyPatch(original, diff.patch ?? "")).toBe(modified)
      const view = normalize({ ...diff, file })
      expect(view.fileDiff.isPartial).toBe(true)
      expect(view.fileDiff.name).toBe(file)
      expect(view.fileDiff.hunks).toHaveLength(3)
      expect(selectionPreview(view, { start: 20_001, end: 20_001 })).toBe(`وسط🙂: ${"x".repeat(75)}`)
      expect(selectionPreview(view, { start: 20_001, end: 20_001, side: "deletions" })).toBe(`20000: ${"x".repeat(75)}`)
      expect(selectionPreview(view, { start: 100, end: 101 })).toBeUndefined()
      yield* snapshot.restore(before)
      expect(yield* fs.readFileString(`${instance.directory}/${file}`)).toBe(original)
      yield* snapshot.restore(after)
      expect(yield* fs.readFileString(`${instance.directory}/${file}`)).toBe(modified)
    }),
  { git: true },
  30_000,
)

it.instance(
  "diffFull retains complete normal files including unusual literal names",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fs = yield* FSUtil.Service
      const snapshot = yield* Snapshot.Service
      const files =
        process.platform === "win32"
          ? ["normal.txt", "עברית.txt"]
          : ["normal.txt", " tab\tname.txt", "line\nname.txt", ":(glob)*.txt", '"quoted"', "עברית.txt"]
      const original = "keep\r\nold🙂\r\nlast"
      const modified = "keep\r\nnew🙂\r\nlast"
      for (const file of files) yield* fs.writeFileString(`${instance.directory}/${file}`, original)
      const before = yield* snapshot.track()
      for (const file of files) yield* fs.writeFileString(`${instance.directory}/${file}`, modified)
      const after = yield* snapshot.track()
      if (!before || !after) throw new Error("Missing snapshot")
      const diffs = yield* snapshot.diffFull(before, after)
      expect(diffs).toHaveLength(files.length)
      for (const file of files) {
        const diff = diffs.find((item) => item.file === file || item.file === JSON.stringify(file))
        expect(diff).toBeDefined()
        if (!diff) throw new Error(`Missing ${file}`)
        if (file === '"quoted"') expect(diff.file).toBe('"\\"quoted\\""')
        expect(diff).toMatchObject({ additions: 1, deletions: 1, status: "modified" })
        expect(applyPatch(original, diff.patch ?? "")).toBe(modified)
        const view = normalize({ ...diff, file })
        expect(view.fileDiff.isPartial).toBe(false)
        expect(text(view, "deletions")).toBe(original)
        expect(text(view, "additions")).toBe(modified)
      }
    }),
  { git: true },
)

it.instance(
  "diffFull bounds aggregate eager context across many otherwise small files",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fs = yield* FSUtil.Service
      const snapshot = yield* Snapshot.Service
      const files = Array.from(
        { length: 40 },
        (_, i) => `${i.toString().padStart(3, "0")} with space${process.platform === "win32" ? "" : "\t\n"}.txt`,
      )
      const original = "keep line\n".repeat(12_000)
      const modified = "changed\n" + original.slice(10)
      for (const file of files) yield* fs.writeFileString(`${instance.directory}/${file}`, original)
      const before = yield* snapshot.track()
      for (const file of files) yield* fs.writeFileString(`${instance.directory}/${file}`, modified)
      const after = yield* snapshot.track()
      if (!before || !after) throw new Error("Missing snapshot")
      const diffs = yield* snapshot.diffFull(before, after)
      expect(diffs.map((diff) => diff.file)).toEqual(
        process.platform === "win32" ? files : files.map((file) => JSON.stringify(file)),
      )
      expect(diffs.reduce((sum, diff) => sum + Buffer.byteLength(diff.patch ?? ""), 0)).toBeLessThan(2_500_000)
      expect(normalize({ ...diffs[0], file: files[0] }).fileDiff.isPartial).toBe(false)
      expect(normalize({ ...diffs[39], file: files[39] }).fileDiff.isPartial).toBe(true)
      for (const [index, diff] of diffs.entries()) {
        expect(diff).toMatchObject({ additions: 1, deletions: 1 })
        expect(applyPatch(original, diff.patch ?? "")).toBe(modified)
        const view = normalize({ ...diff, file: files[index] })
        expect(view.fileDiff.name).toBe(files[index])
        expect(selectionPreview(view, { start: 1, end: 1 })).toBe("changed")
      }
    }),
  { git: true },
  30_000,
)

it.instance(
  "diffFull never drops changed bytes in oversized additions and deletions",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fs = yield* FSUtil.Service
      const snapshot = yield* Snapshot.Service
      const original = "changed\n".repeat(40_000)
      yield* fs.writeFileString(`${instance.directory}/deleted.txt`, original)
      const before = yield* snapshot.track()
      yield* fs.remove(`${instance.directory}/deleted.txt`)
      yield* fs.writeFileString(`${instance.directory}/added.txt`, original)
      const after = yield* snapshot.track()
      if (!before || !after) throw new Error("Missing snapshot")
      const diffs = yield* snapshot.diffFull(before, after)
      expect(diffs).toHaveLength(2)
      const added = diffs.find((diff) => diff.file === "added.txt")
      const deleted = diffs.find((diff) => diff.file === "deleted.txt")
      expect(added).toMatchObject({ additions: 40_000, deletions: 0, status: "added" })
      expect(deleted).toMatchObject({ additions: 0, deletions: 40_000, status: "deleted" })
      expect(applyPatch("", added?.patch ?? "")).toBe(original)
      expect(applyPatch(original, deleted?.patch ?? "")).toBe("")
    }),
  { git: true },
)

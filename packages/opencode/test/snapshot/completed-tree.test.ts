import { expect } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Snapshot } from "../../src/snapshot"
import { TestInstance, provideInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

class Probe extends Context.Service<
  Probe,
  {
    commands: string[][]
    fail?: string
    pause?: { entered: Deferred.Deferred<void>; released: Deferred.Deferred<void> }
  }
>()("SnapshotCompletedTreeTest") {}

const probe = Layer.sync(Probe, () => ({ commands: [] }))
const observed = Layer.effect(
  AppProcess.Service,
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const probe = yield* Probe
    return AppProcess.Service.of({
      ...process,
      run: (command, options) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") return yield* process.run(command, options)
          probe.commands.push([...command.args])
          if (probe.fail && command.args.includes(probe.fail)) {
            return {
              command: command.command,
              exitCode: 1,
              stdout: Buffer.alloc(0),
              stderr: Buffer.from("injected failure"),
              stdoutTruncated: false,
              stderrTruncated: false,
            }
          }
          const result = yield* process.run(command, options)
          if (probe.pause && command.args.includes("diff")) {
            const pause = probe.pause
            yield* Deferred.succeed(pause.entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(pause.released, undefined)),
            )
          }
          return result
        }),
    })
  }),
).pipe(Layer.provide(Layer.mergeAll(LayerNode.compile(AppProcess.node), probe)))

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node, AppProcess.node, CrossSpawnSpawner.node]), [
      [AppProcess.node, observed],
    ]),
    testInstanceStoreLayer,
    probe,
  ),
)

const tracked = (snapshot: Snapshot.Interface) =>
  snapshot.track().pipe(
    Effect.map((hash) => {
      if (!hash) throw new Error("expected snapshot tree")
      return hash
    }),
  )
const fwd = (file: string) => file.replaceAll("\\", "/")

it.instance(
  "completed tree is an immutable boundary and keeps the undo baseline",
  () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const snapshot = yield* Snapshot.Service
      const probe = yield* Probe
      const tmp = yield* TestInstance
      const dir = tmp.directory
      for (const name of ["edit", "delete", "rename", "ignored", "untouched"]) {
        yield* fs.writeFileString(`${dir}/${name}.txt`, `${name} original\n`)
      }
      const before = yield* tracked(snapshot)
      yield* fs.writeFileString(`${dir}/edit.txt`, "captured edit\n")
      yield* fs.remove(`${dir}/delete.txt`)
      yield* fs.rename(`${dir}/rename.txt`, `${dir}/renamed.txt`)
      yield* fs.writeFileString(`${dir}/added.txt`, "captured addition\n")
      yield* fs.writeFileString(`${dir}/ignored.txt`, "now ignored\n")
      yield* fs.writeFileString(`${dir}/.gitignore`, "ignored.txt\n*.log\n")
      yield* fs.writeFileString(`${dir}/noise.log`, "ignored addition\n")
      const completed = yield* tracked(snapshot)
      // A second capture may change the shared index before patch() acquires its lock.
      yield* fs.writeFileString(`${dir}/edit.txt`, "edit original\n")
      yield* fs.writeFileString(`${dir}/untouched.txt`, "external modification after capture\n")
      yield* fs.writeFileString(`${dir}/late.txt`, "external addition after capture\n")
      yield* tracked(snapshot)
      probe.commands.length = 0
      const patch = yield* snapshot.patch(before, completed)
      expect(patch.hash).toBe(before)
      expect(patch.files.sort()).toEqual(
        [".gitignore", "added.txt", "delete.txt", "edit.txt", "rename.txt", "renamed.txt"]
          .map((x) => fwd(`${dir}/${x}`))
          .sort(),
      )
      expect(
        probe.commands.some((args) => args.includes("add") || args.includes("diff-files") || args.includes("ls-files")),
      ).toBe(false)
      yield* snapshot.revert([patch])
      expect(yield* fs.readFileString(`${dir}/delete.txt`)).toBe("delete original\n")
      expect(yield* fs.readFileString(`${dir}/rename.txt`)).toBe("rename original\n")
      expect(yield* fs.readFileString(`${dir}/edit.txt`)).toBe("edit original\n")
      expect(yield* fs.exists(`${dir}/renamed.txt`)).toBe(false)
      expect(yield* fs.exists(`${dir}/added.txt`)).toBe(false)
      expect(yield* fs.readFileString(`${dir}/untouched.txt`)).toBe("external modification after capture\n")
      expect(yield* fs.exists(`${dir}/late.txt`)).toBe(true)
    }),
  { git: true },
)

it.instance(
  "equal completed trees exclude later edits; one-argument patch still sees them",
  () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const snapshot = yield* Snapshot.Service
      const tmp = yield* TestInstance
      const before = yield* tracked(snapshot)
      const completed = yield* tracked(snapshot)
      yield* fs.writeFileString(`${tmp.directory}/late.txt`, "late\n")
      expect((yield* snapshot.patch(before, completed)).files).toEqual([])
      expect((yield* snapshot.patch(before)).files).toEqual([fwd(`${tmp.directory}/late.txt`)])
    }),
  { git: true },
)

it.instance(
  "completed comparison retains current ignore filtering",
  () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const snapshot = yield* Snapshot.Service
      const tmp = yield* TestInstance
      const before = yield* tracked(snapshot)
      yield* fs.writeFileString(`${tmp.directory}/added.txt`, "captured\n")
      const completed = yield* tracked(snapshot)
      yield* fs.writeFileString(`${tmp.directory}/.git/info/exclude`, "added.txt\n")
      expect((yield* snapshot.patch(before, completed)).files).toEqual([])
    }),
  { git: true },
)

it.instance(
  "completed trees remain scoped to a subtree in a linked worktree",
  () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* TestInstance
      const worktree = `${tmp.directory}/linked`
      const result = yield* Effect.promise(async () => {
        const child = Bun.spawn(["git", "worktree", "add", "--detach", worktree, "HEAD"], {
          cwd: tmp.directory,
          stdout: "ignore",
          stderr: "pipe",
        })
        return child.exited
      })
      expect(result).toBe(0)
      yield* fs.ensureDir(`${worktree}/sub`)
      yield* Effect.gen(function* () {
        const snapshot = yield* Snapshot.Service
        const before = yield* tracked(snapshot)
        yield* fs.writeFileString(`${worktree}/outside.txt`, "outside\n")
        yield* fs.writeFileString(`${worktree}/sub/inside.txt`, "inside\n")
        yield* fs.writeFileString(`${worktree}/sub/.gitignore`, "*.log\n")
        yield* fs.writeFileString(`${worktree}/sub/noise.log`, "ignored\n")
        const completed = yield* tracked(snapshot)
        yield* fs.writeFileString(`${worktree}/sub/late.txt`, "late\n")
        const patch = yield* snapshot.patch(before, completed)
        expect(patch.files.sort()).toEqual(
          [fwd(`${worktree}/sub/.gitignore`), fwd(`${worktree}/sub/inside.txt`)].sort(),
        )
        yield* snapshot.revert([patch])
        expect(yield* fs.exists(`${worktree}/outside.txt`)).toBe(true)
        expect(yield* fs.exists(`${worktree}/sub/inside.txt`)).toBe(false)
        expect(yield* fs.exists(`${worktree}/sub/late.txt`)).toBe(true)
      }).pipe(provideInstance(`${worktree}/sub`))
    }),
  { git: true },
)

it.instance(
  "missing and failed completion trees fall back to the current worktree",
  () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const snapshot = yield* Snapshot.Service
      const probe = yield* Probe
      const tmp = yield* TestInstance
      const before = yield* tracked(snapshot)
      yield* fs.writeFileString(`${tmp.directory}/new.txt`, "new\n")
      for (const completed of [undefined, "", "0".repeat(40)]) {
        expect((yield* snapshot.patch(before, completed)).files).toEqual([fwd(`${tmp.directory}/new.txt`)])
      }
      for (const fail of ["diff-files", "ls-files", "add", "write-tree"]) {
        yield* fs.writeFileString(`${tmp.directory}/new.txt`, `${fail}\n`)
        probe.fail = fail
        const completed = yield* snapshot.track()
        expect(completed).toBeUndefined()
        probe.fail = undefined
        expect((yield* snapshot.patch(before, completed)).files).toEqual([fwd(`${tmp.directory}/new.txt`)])
      }
      yield* fs.writeFileString(`${tmp.directory}/.gitignore`, "new.txt\n")
      yield* fs.writeFileString(`${tmp.directory}/new.txt`, "newly ignored\n")
      probe.fail = "rm"
      expect(yield* snapshot.track()).toBeUndefined()
      probe.fail = undefined
      expect((yield* snapshot.patch(before)).files).toEqual([fwd(`${tmp.directory}/.gitignore`)])
      expect((yield* snapshot.patch("0".repeat(40), yield* tracked(snapshot))).files).toEqual([])
    }),
  { git: true },
)

it.instance(
  "cancelling completed comparison releases its permit for cleanup patch",
  () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const snapshot = yield* Snapshot.Service
      const probe = yield* Probe
      const tmp = yield* TestInstance
      const before = yield* tracked(snapshot)
      yield* fs.writeFileString(`${tmp.directory}/new.txt`, "new\n")
      const completed = yield* tracked(snapshot)
      const pause = { entered: yield* Deferred.make<void>(), released: yield* Deferred.make<void>() }
      probe.pause = pause
      const fiber = yield* snapshot.patch(before, completed).pipe(Effect.forkChild)
      yield* Deferred.await(pause.entered)
      yield* Fiber.interrupt(fiber)
      yield* Deferred.await(pause.released)
      probe.pause = undefined
      yield* fs.writeFileString(`${tmp.directory}/late.txt`, "late\n")
      expect((yield* snapshot.patch(before).pipe(Effect.timeout("2 seconds"))).files.sort()).toEqual(
        [fwd(`${tmp.directory}/late.txt`), fwd(`${tmp.directory}/new.txt`)].sort(),
      )
    }),
  { git: true },
)

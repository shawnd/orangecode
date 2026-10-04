import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { parsePatch } from "diff"
import { Deferred, Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Git } from "../../src/git"
import { Vcs } from "@/project/vcs"
import { testEffect } from "../lib/effect"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const weird = process.platform === "win32" ? "space file.txt" : "tab\tfile.txt"

const layer = LayerNode.compile(
  LayerNode.group([Vcs.node, Git.node, EventV2Bridge.node, FSUtil.node, CrossSpawnSpawner.node]),
)
const it = testEffect(layer)
const worktreeIt = testEffect(Layer.mergeAll(layer, testInstanceStoreLayer))
const controlledIt = testEffect(Layer.empty)
const diffLayer = (git: Partial<Git.Interface>) =>
  LayerNode.compile(Vcs.node, [[Git.node, Layer.mock(Git.Service, git)]])

const git = Effect.fn("VcsTest.git")(function* (cwd: string, args: string[]) {
  const result = yield* Git.Service.use((git) => git.run(args, { cwd }))
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
})

const write = Effect.fn("VcsTest.write")(function* (file: string, content: string) {
  yield* FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))
})

const remove = Effect.fn("VcsTest.remove")(function* (file: string) {
  yield* FSUtil.Service.use((fs) => fs.remove(file))
})

const symlink = (target: string, file: string) => Effect.promise(() => fs.symlink(target, file))

const init = Effect.fn("VcsTest.init")(function* () {
  const vcs = yield* Vcs.Service
  yield* vcs.init()
  return vcs
})

const nextBranchUpdate = Effect.fn("VcsTest.nextBranchUpdate")(function* () {
  const events = yield* EventV2Bridge.Service
  const updated = yield* Deferred.make<string | undefined>()

  const off = yield* events.listen((event) => {
    if (event.type === Vcs.Event.BranchUpdated.type)
      Deferred.doneUnsafe(updated, Effect.succeed((event.data as typeof Vcs.Event.BranchUpdated.data.Type).branch))
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  return updated
})

const publishHeadChangeUntil = Effect.fn("VcsTest.publishHeadChangeUntil")(function* (
  pending: Deferred.Deferred<string | undefined>,
  head: string,
) {
  const events = yield* EventV2Bridge.Service
  for (let i = 0; i < 50; i++) {
    yield* events.publish(Watcher.Event.Updated, { file: head, event: "change" })
    if (yield* Deferred.isDone(pending)) return
    yield* Effect.sleep("10 millis")
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Vcs", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance(
    "branch() returns current branch name",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        const branch = yield* vcs.branch()

        expect(branch).toBeDefined()
        expect(typeof branch).toBe("string")
      }),
    { git: true },
  )

  it.instance("branch() returns undefined for non-git directories", () =>
    Effect.gen(function* () {
      const vcs = yield* init()
      const branch = yield* vcs.branch()

      expect(branch).toBeUndefined()
    }),
  )

  it.instance(
    "publishes BranchUpdated when .git/HEAD changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = `test-${Math.random().toString(36).slice(2)}`
        yield* git(test.directory, ["branch", branch])

        const vcs = yield* init()
        yield* vcs.branch()
        const pending = yield* nextBranchUpdate()

        const head = path.join(test.directory, ".git", "HEAD")
        yield* write(head, `ref: refs/heads/${branch}\n`)
        yield* publishHeadChangeUntil(pending, head)

        const updated = yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))
        expect(updated).toBe(branch)
      }),
    { git: true },
  )

  it.instance(
    "branch() reflects the new branch after HEAD change",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = `test-${Math.random().toString(36).slice(2)}`
        yield* git(test.directory, ["branch", branch])

        const vcs = yield* init()
        yield* vcs.branch()
        const pending = yield* nextBranchUpdate()

        const head = path.join(test.directory, ".git", "HEAD")
        yield* write(head, `ref: refs/heads/${branch}\n`)
        yield* publishHeadChangeUntil(pending, head)
        yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))

        const current = yield* vcs.branch()
        expect(current).toBe(branch)
      }),
    { git: true },
  )
})

describe("Vcs diff", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  controlledIt.instance(
    "summary returns the whole tree without reading patches or counting file contents",
    () =>
      Effect.gen(function* () {
        const vcs = yield* Vcs.Service
        expect(yield* vcs.diff("git", { view: "summary" })).toEqual([
          { file: "a.txt", additions: 0, deletions: 0, status: "modified" },
          { file: "z.tar.gz", additions: 0, deletions: 0, status: "added" },
        ])
      }).pipe(
        Effect.provide(
          diffLayer({
            hasHead: () => Effect.succeed(true),
            diff: () => Effect.succeed([{ file: "a.txt", code: "M", status: "modified" }]),
            status: () => Effect.succeed([{ file: "z.tar.gz", code: "??", status: "added" }]),
          }),
        ),
      ),
    { git: true },
  )

  it.instance(
    "individual patches match the complete diff including literal paths and untracked files",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "[a].txt"), "before\n")
        yield* write(path.join(test.directory, "a.txt"), "before\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "-m", "fixture"])
        yield* write(path.join(test.directory, "[a].txt"), "after\n")
        yield* write(path.join(test.directory, "a.txt"), "after\n")
        yield* write(path.join(test.directory, "new.txt"), "new\n")
        const vcs = yield* Vcs.Service
        const all = yield* vcs.diff("git", { context: 12 })
        expect(all).toHaveLength(3)
        for (const file of all) {
          expect(yield* vcs.diff("git", { file: file.file, context: 12 })).toEqual([file])
          expect(yield* vcs.diff("git", { view: "summary", file: file.file })).toEqual([
            { file: file.file, status: file.status, additions: 0, deletions: 0 },
          ])
        }
        expect(yield* vcs.diff("git", { file: "missing.txt" })).toEqual([])
        expect(yield* vcs.diff("git", { file: "" })).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "summary and individual patches work before the first commit",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["update-ref", "-d", "HEAD"])
        yield* write(path.join(test.directory, "staged.txt"), "staged\n")
        yield* git(test.directory, ["add", "staged.txt"])
        yield* write(path.join(test.directory, "untracked.txt"), "untracked\n")
        const vcs = yield* Vcs.Service
        expect(yield* vcs.diff("git", { view: "summary" })).toEqual([
          { file: "staged.txt", status: "added", additions: 0, deletions: 0 },
          { file: "untracked.txt", status: "added", additions: 0, deletions: 0 },
        ])
        const all = yield* vcs.diff("git")
        for (const file of all) {
          expect(yield* vcs.diff("git", { file: file.file })).toEqual([file])
        }
      }),
    { git: true },
  )

  controlledIt.instance(
    "a single-file request never prepares unrelated patches or untracked stats",
    () =>
      Effect.gen(function* () {
        const vcs = yield* Vcs.Service
        expect(yield* vcs.diff("git", { file: "a.txt", context: 12 })).toEqual([
          { file: "a.txt", patch: "patch", status: "modified", additions: 1, deletions: 1 },
        ])
      }).pipe(
        Effect.provide(
          diffLayer({
            hasHead: () => Effect.succeed(true),
            diff: () => Effect.succeed([{ file: "a.txt", code: "M", status: "modified" }]),
            status: () => Effect.succeed([{ file: "z.tar.gz", code: "??", status: "added" }]),
            stats: (_cwd, _ref, file) => {
              expect(file).toBe("a.txt")
              return Effect.succeed([{ file: "a.txt", additions: 1, deletions: 1 }])
            },
            patch: (_cwd, _ref, file, options) => {
              expect(file).toBe("a.txt")
              expect(options?.context).toBe(12)
              return Effect.succeed({ text: "patch", truncated: false })
            },
          }),
        ),
      ),
    { git: true },
  )

  controlledIt.instance(
    "diff('git') does not initialize branch discovery",
    () =>
      Effect.gen(function* () {
        const vcs = yield* Vcs.Service
        expect(yield* vcs.diff("git")).toEqual([])
      }).pipe(
        Effect.provide(
          diffLayer({
            hasHead: () => Effect.succeed(true),
            diff: () => Effect.succeed([]),
            stats: () => Effect.succeed([]),
            status: () => Effect.succeed([]),
          }),
        ),
      ),
    { git: true },
  )

  controlledIt.instance(
    "diff('git') bounds concurrent untracked work and preserves file order",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        const patched = yield* Deferred.make<void>()
        const completed: string[] = []
        let active = 0
        let peak = 0
        const diff = yield* Effect.gen(function* () {
          const vcs = yield* Vcs.Service
          return yield* vcs.diff("git", { context: 3 })
        }).pipe(
          Effect.provide(
            diffLayer({
              hasHead: () => Effect.succeed(false),
              status: () =>
                Effect.succeed(
                  Array.from({ length: 9 }, (_, index) => ({
                    file: `${8 - index}.txt`,
                    code: "??",
                    status: "added" as const,
                  })),
                ),
              statUntracked: (_cwd, file) =>
                Effect.gen(function* () {
                  active++
                  peak = Math.max(peak, active)
                  if (active === 4) yield* Deferred.succeed(ready, undefined)
                  yield* Deferred.await(ready)
                  active--
                  return { file, additions: 1, deletions: 0 }
                }),
              patchUntracked: (_cwd, file, options) =>
                Effect.gen(function* () {
                  expect(options).toEqual({ context: 3, maxOutputBytes: 10_000_000 })
                  if (file === "0.txt") yield* Deferred.await(patched)
                  completed.push(file)
                  if (file === "3.txt") yield* Deferred.succeed(patched, undefined)
                  return { text: `patch ${file}`, truncated: false }
                }),
            }),
          ),
          Effect.timeout("5 seconds"),
        )
        expect(peak).toBe(4)
        expect(completed[0]).not.toBe("0.txt")
        expect(diff).toEqual(
          Array.from({ length: 9 }, (_, index) => ({
            file: `${index}.txt`,
            patch: `patch ${index}.txt`,
            additions: 1,
            deletions: 0,
            status: "added",
          })),
        )
      }),
    { git: true },
  )

  controlledIt.instance(
    "diff('git') applies the global byte cap in file order and stops later patch batches",
    () =>
      Effect.gen(function* () {
        for (const size of [4_000_000, 4_000_001]) {
          const requested: string[] = []
          const diff = yield* Effect.gen(function* () {
            const vcs = yield* Vcs.Service
            return yield* vcs.diff("git")
          }).pipe(
            Effect.provide(
              diffLayer({
                hasHead: () => Effect.succeed(false),
                status: () =>
                  Effect.succeed(
                    Array.from({ length: 9 }, (_, index) => ({
                      file: `${8 - index}.txt`,
                      code: "??",
                      status: "added" as const,
                    })),
                  ),
                statUntracked: (_cwd, file) => Effect.succeed({ file, additions: 1, deletions: 0 }),
                patchUntracked: (_cwd, file) =>
                  Effect.sync(() => {
                    requested.push(file)
                    return {
                      text: file === "0.txt" ? "é".repeat(3_000_000) : file === "1.txt" ? "x".repeat(size) : "later",
                      truncated: false,
                    }
                  }),
              }),
            ),
          )
          expect(Buffer.byteLength(diff[0].patch ?? "")).toBe(6_000_000)
          expect(requested).toEqual(["0.txt", "1.txt", "2.txt", "3.txt"])
          if (size === 4_000_000) expect(Buffer.byteLength(diff[1].patch ?? "")).toBe(size)
          for (const item of diff.slice(size === 4_000_000 ? 2 : 1)) {
            expect(parsePatch(item.patch ?? "")[0].hunks).toEqual([])
            expect(item.additions).toBe(1)
            expect(item.status).toBe("added")
          }
        }
      }),
    { git: true },
    20_000,
  )

  controlledIt.instance(
    "diff('git') keeps individual truncation local to its file",
    () =>
      Effect.gen(function* () {
        const vcs = yield* Vcs.Service
        const diff = yield* vcs.diff("git")
        expect(parsePatch(diff[0].patch ?? "")[0].hunks).toEqual([])
        expect(diff[1].patch).toBe("complete")
      }).pipe(
        Effect.provide(
          diffLayer({
            hasHead: () => Effect.succeed(false),
            status: () =>
              Effect.succeed([
                { file: "a.txt", code: "??", status: "added" },
                { file: "b.txt", code: "??", status: "added" },
              ]),
            statUntracked: (_cwd, file) => Effect.succeed({ file, additions: 1, deletions: 0 }),
            patchUntracked: (_cwd, file) =>
              Effect.succeed({ text: file === "a.txt" ? "partial" : "complete", truncated: file === "a.txt" }),
          }),
        ),
      ),
    { git: true },
  )

  it.instance(
    "diff('git') preserves tracked additions, deletions, binary files and untracked patches across batches",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "a-deleted.txt"), "remove\n")
        yield* write(path.join(test.directory, "b-modified.txt"), "before\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add files"])
        yield* remove(path.join(test.directory, "a-deleted.txt"))
        yield* write(path.join(test.directory, "b-modified.txt"), "after\n")
        yield* write(path.join(test.directory, "c-staged.txt"), "staged\n")
        yield* git(test.directory, ["add", "c-staged.txt"])
        yield* write(path.join(test.directory, "d-binary.bin"), "\0binary\n")
        yield* Effect.forEach(["e.txt", "f.txt", "g.txt", weird], (file) =>
          write(path.join(test.directory, file), "untracked\n"),
        )

        const vcs = yield* Vcs.Service
        const diff = yield* vcs.diff("git")
        expect(diff.map((item) => item.file)).toEqual(
          [
            "a-deleted.txt",
            "b-modified.txt",
            "c-staged.txt",
            "d-binary.bin",
            "e.txt",
            "f.txt",
            "g.txt",
            weird,
          ].toSorted((a, b) => a.localeCompare(b)),
        )
        expect(diff[0]).toMatchObject({ status: "deleted", additions: 0, deletions: 1 })
        expect(diff[0].patch).toContain("-remove")
        expect(diff[1]).toMatchObject({ status: "modified", additions: 1, deletions: 1 })
        expect(diff[1].patch).toContain("+after")
        expect(diff[2]).toMatchObject({ status: "added", additions: 1, deletions: 0 })
        expect(diff[2].patch).toContain("+staged")
        expect(diff[3]).toMatchObject({ status: "added", additions: 0, deletions: 0 })
        expect(diff[3].patch).toContain("Binary files")
        diff.slice(4).forEach((item) => {
          expect(item).toMatchObject({ status: "added", additions: 1, deletions: 0 })
          expect(item.patch).toContain("+untracked")
        })
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "diff('git') handles an unborn HEAD across untracked batches",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["checkout", "--orphan", "unborn"])
        yield* Effect.forEach(["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"], (file) =>
          write(path.join(test.directory, file), "new\n"),
        )
        const vcs = yield* Vcs.Service
        const diff = yield* vcs.diff("git")
        expect(diff.map((item) => item.file)).toEqual(["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"])
        diff.forEach((item) => {
          expect(item).toMatchObject({ status: "added", additions: 1, deletions: 0 })
          expect(item.patch).toContain("+new")
        })
      }),
    { git: true },
  )

  it.instance(
    "defaultBranch() falls back to main",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])

        const vcs = yield* init()
        const branch = yield* vcs.defaultBranch()

        expect(branch).toBe("main")
      }),
    { git: true },
  )

  it.instance(
    "defaultBranch() uses init.defaultBranch when available",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "trunk"])
        yield* git(test.directory, ["config", "init.defaultBranch", "trunk"])

        const vcs = yield* init()
        const branch = yield* vcs.defaultBranch()

        expect(branch).toBe("trunk")
      }),
    { git: true },
  )

  worktreeIt.live("detects current branch from the active worktree", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const wt = yield* tmpdirScoped()
      yield* git(tmp, ["branch", "-M", "main"])
      const dir = path.join(wt, "feature")
      yield* git(tmp, ["worktree", "add", "-b", "feature/test", dir, "HEAD"])

      const [branch, base] = yield* Effect.gen(function* () {
        const vcs = yield* init()
        return yield* Effect.all([vcs.branch(), vcs.defaultBranch()], { concurrency: 2 })
      }).pipe(provideInstance(dir))

      expect(branch).toBeDefined()
      expect(branch).toBe("feature/test")
      expect(base).toBe("main")
    }),
  )

  it.instance(
    "diff('git') returns uncommitted changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "file.txt"), "original\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add file"])
        yield* write(path.join(test.directory, "file.txt"), "changed\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "file.txt",
              status: "modified",
            }),
          ]),
        )
        expect(diff.find((item) => item.file === "file.txt")?.patch).toContain("diff --git")
      }),
    { git: true },
  )

  it.instance(
    "diff('git') handles special filenames",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, weird), "hello\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: weird,
              status: "added",
            }),
          ]),
        )
      }),
    { git: true },
  )

  it.instance(
    "diff('git') keeps batched patches aligned for type changes",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const test = yield* TestInstance
        yield* write(path.join(test.directory, "a.txt"), "old\n")
        yield* write(path.join(test.directory, "b.txt"), "old\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add files"])
        yield* remove(path.join(test.directory, "a.txt"))
        yield* symlink("target", path.join(test.directory, "a.txt"))
        yield* write(path.join(test.directory, "b.txt"), "new\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")
        const a = diff.find((item) => item.file === "a.txt")
        const b = diff.find((item) => item.file === "b.txt")

        expect(a?.patch).toContain("deleted file mode")
        expect(a?.patch).toContain("new file mode")
        expect(b?.patch).toContain("+new")
      }),
    { git: true },
  )

  it.instance(
    "diff('git') keeps carriage returns inside patch hunks",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "file.txt"), "keep\nsame\rdiff --git inside\ndelete\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add file"])
        yield* write(path.join(test.directory, "file.txt"), "keep\nadd\nsame\rdiff --git inside\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")
        const file = diff.find((item) => item.file === "file.txt")

        expect(file?.patch).toContain(" same\rdiff --git inside")
        expect(file?.patch).toContain("-delete")
        expect(() => parsePatch(file?.patch ?? "")).not.toThrow()
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "diff('branch') returns changes against default branch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(test.directory, ["checkout", "-b", "feature/test"])
        yield* write(path.join(test.directory, "branch.txt"), "hello\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "branch file"])
        yield* write(path.join(test.directory, "untracked.txt"), "untracked\n")

        const vcs = yield* Vcs.Service
        const diff = yield* vcs.diff("branch")
        expect(yield* vcs.diff("branch", { view: "summary" })).toEqual([
          { file: "branch.txt", status: "added", additions: 0, deletions: 0 },
          { file: "untracked.txt", status: "added", additions: 0, deletions: 0 },
        ])
        for (const file of diff) {
          expect(yield* vcs.diff("branch", { file: file.file })).toEqual([file])
        }

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "branch.txt",
              status: "added",
            }),
          ]),
        )
      }),
    { git: true },
  )
})

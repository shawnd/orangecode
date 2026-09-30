import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Duration, Effect, Layer, Schedule, Schema, Semaphore, Context } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { formatPatch } from "diff"
import path from "path"
import { AppProcess } from "@opencode-ai/core/process"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Hash } from "@opencode-ai/core/util/hash"
import { Config } from "@/config/config"
import { Global } from "@opencode-ai/core/global"
import { Info } from "@opencode-ai/schema/file-diff"

export const Patch = Schema.Struct({
  hash: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
})
export type Patch = typeof Patch.Type

export const FileDiff = Info
export type FileDiff = typeof FileDiff.Type

const prune = "7.days"
const limit = 2 * 1024 * 1024
// Bound eager unchanged context, not changed content or snapshot capture.
const fullContextFileBytes = 256 * 1024
const fullContextTotalBytes = 4 * 1024 * 1024
const diffBatchBytes = 8 * 1024 * 1024
const core = ["-c", "core.longpaths=true", "-c", "core.symlinks=true"]
const cfg = ["-c", "core.autocrlf=false", ...core]
const quote = [...cfg, "-c", "core.quotepath=false"]
interface GitResult {
  readonly code: ChildProcessSpawner.ExitCode
  readonly text: string
  readonly stderr: string
}

type State = Omit<Interface, "init">

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly cleanup: () => Effect.Effect<void>
  readonly track: () => Effect.Effect<string | undefined>
  readonly patch: (hash: string, completed?: string) => Effect.Effect<Patch>
  readonly restore: (snapshot: string) => Effect.Effect<void>
  readonly revert: (patches: Patch[]) => Effect.Effect<void>
  readonly diff: (hash: string) => Effect.Effect<string>
  readonly stats: (from: string, to: string, files: readonly string[]) => Effect.Effect<FileDiff[]>
  readonly diffFull: (from: string, to: string) => Effect.Effect<FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Snapshot") {}

const layer: Layer.Layer<Service, never, FSUtil.Service | AppProcess.Service | Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const config = yield* Config.Service
    const locks = new Map<string, Semaphore.Semaphore>()

    const lock = (key: string) => {
      const hit = locks.get(key)
      if (hit) return hit

      const next = Semaphore.makeUnsafe(1)
      locks.set(key, next)
      return next
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("Snapshot.state")(function* (ctx) {
        const state = {
          directory: ctx.directory,
          worktree: ctx.worktree,
          gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree)),
          vcs: ctx.project.vcs,
        }

        const args = (cmd: string[]) => ["--git-dir", state.gitdir, "--work-tree", state.worktree, ...cmd]

        const encodeNulTerminatedPaths = (files: string[]) => files.join("\0") + "\0"
        const encodeTopLevelLiteralPathspecs = (files: string[]) =>
          encodeNulTerminatedPaths(files.map((file) => `:(top,literal)${file}`))

        const git = Effect.fnUntraced(
          function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string>; stdin?: string }) {
            const result = yield* appProcess.run(
              ChildProcess.make("git", cmd, { cwd: opts?.cwd, env: opts?.env, extendEnv: true }),
              { stdin: opts?.stdin },
            )
            return {
              code: ChildProcessSpawner.ExitCode(result.exitCode),
              text: result.stdout.toString("utf8"),
              stderr: result.stderr.toString("utf8"),
            } satisfies GitResult
          },
          Effect.catch((err) =>
            Effect.succeed({
              code: ChildProcessSpawner.ExitCode(1),
              text: "",
              stderr: err instanceof Error ? err.message : String(err),
            }),
          ),
        )

        const ignore = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return new Set<string>()
          // check-ignore treats a leading colon as pathspec magic but accepts and echoes a protective ./ prefix.
          const checkIgnorePaths = files.map((item) => (item.startsWith(":") ? `./${item}` : item))
          const check = yield* git(
            [
              ...quote,
              "--git-dir",
              path.join(state.worktree, ".git"),
              "--work-tree",
              state.worktree,
              "check-ignore",
              "--no-index",
              "--stdin",
              "-z",
            ],
            {
              cwd: state.worktree,
              stdin: encodeNulTerminatedPaths(checkIgnorePaths),
            },
          )
          if (check.code !== 0 && check.code !== 1) return new Set<string>()
          return new Set(
            check.text
              .split("\0")
              .filter(Boolean)
              .map((item) => (item.startsWith("./:") ? item.slice(2) : item)),
          )
        })

        const drop = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return true
          const result = yield* git(
            [
              ...cfg,
              ...args(["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"]),
            ],
            {
              cwd: state.worktree,
              stdin: encodeTopLevelLiteralPathspecs(files),
            },
          )
          return result.code === 0
        })

        const stage = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return true
          const result = yield* git(
            [...cfg, ...args(["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"])],
            {
              cwd: state.worktree,
              stdin: encodeTopLevelLiteralPathspecs(files),
            },
          )
          if (result.code === 0) return true
          yield* Effect.logWarning("failed to add snapshot files", {
            exitCode: result.code,
            stderr: result.stderr,
          })
          return false
        })

        const exists = (file: string) => fs.exists(file).pipe(Effect.orDie)
        const read = (file: string) => fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
        const remove = (file: string) => fs.remove(file).pipe(Effect.catch(() => Effect.void))
        const locked = <A, E, R>(fx: Effect.Effect<A, E, R>) => lock(state.gitdir).withPermits(1)(fx)

        const enabled = Effect.fnUntraced(function* () {
          if (state.vcs !== "git") return false
          return (yield* config.get()).snapshot !== false
        })

        const excludes = Effect.fnUntraced(function* () {
          const result = yield* git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
            cwd: state.worktree,
          })
          const file = result.text.trim()
          if (!file) return
          if (!(yield* exists(file))) return
          return file
        })

        const sync = Effect.fnUntraced(function* (list: string[] = []) {
          const file = yield* excludes()
          const target = path.join(state.gitdir, "info", "exclude")
          const text = [
            file ? (yield* read(file)).trimEnd() : "",
            ...list.map((item) => `/${item.replaceAll("\\", "/")}`),
          ]
            .filter(Boolean)
            .join("\n")
          yield* fs.ensureDir(path.join(state.gitdir, "info")).pipe(Effect.orDie)
          yield* fs.writeFileString(target, text ? `${text}\n` : "").pipe(Effect.orDie)
        })

        // Reuse the hashes for the git storage between the original repo and snapshot
        // on huge repos like chromium checkout the git add --all rebuilding the
        // hashes can take minutes. By doing this we eliminating this at all
        const seed = Effect.fnUntraced(function* () {
          if (state.vcs !== "git") return

          const commonDir = yield* git(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
            cwd: state.worktree,
          })

          if (commonDir.code !== 0) return
          const source = commonDir.text.trim()
          if (!source || !(yield* exists(source))) return

          // Share the source object database (and the source's own alternates,
          // skipping any that no longer exist) so seeded blobs resolve.
          const sourceObjects = path.join(source, "objects")
          const chained = (yield* read(path.join(sourceObjects, "info", "alternates")))
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
          const alternates: string[] = []
          for (const candidate of [sourceObjects, ...chained]) {
            if (yield* exists(candidate)) alternates.push(candidate)
          }
          if (!alternates.length) return

          yield* fs.ensureDir(path.join(state.gitdir, "objects", "info")).pipe(Effect.orDie)
          yield* fs
            .writeFileString(path.join(state.gitdir, "objects", "info", "alternates"), alternates.join("\n") + "\n")
            .pipe(Effect.orDie)

          // Seed the index from the source repo so already-hashed entries are reused.
          // Best-effort: a missing/incompatible index just falls back to a full add.
          const sourceIndex = path.join(source, "index")
          if (yield* exists(sourceIndex)) {
            yield* fs.copyFile(sourceIndex, path.join(state.gitdir, "index")).pipe(Effect.catch(() => Effect.void))
          }
        })

        const add = Effect.fnUntraced(function* () {
          yield* sync()
          const [diff, other] = yield* Effect.all(
            [
              git([...quote, ...args(["diff-files", "--name-only", "-z", "--", "."])], {
                cwd: state.directory,
              }),
              git([...quote, ...args(["ls-files", "--full-name", "--others", "--exclude-standard", "-z", "--", "."])], {
                cwd: state.directory,
              }),
            ],
            { concurrency: 2 },
          )
          if (diff.code !== 0 || other.code !== 0) {
            yield* Effect.logWarning("failed to list snapshot files", {
              diffCode: diff.code,
              diffStderr: diff.stderr,
              otherCode: other.code,
              otherStderr: other.stderr,
            })
            return false
          }

          const tracked = diff.text.split("\0").filter(Boolean)
          const untracked = other.text.split("\0").filter(Boolean)
          const all = Array.from(new Set([...tracked, ...untracked]))
          if (!all.length) return true

          // Resolve source-repo ignore rules against the exact candidate set.
          // --no-index keeps this pattern-based even when a path is already tracked.
          const ignored = yield* ignore(all)

          // Remove newly-ignored files from snapshot index to prevent re-adding
          if (ignored.size > 0) {
            const ignoredFiles = Array.from(ignored)
            yield* Effect.logInfo("removing gitignored files from snapshot", { count: ignoredFiles.length })
            if (!(yield* drop(ignoredFiles))) return false
          }

          const allow = all.filter((item) => !ignored.has(item))
          if (!allow.length) return true

          const large = new Set(
            (yield* Effect.all(
              allow.map((item) =>
                fs
                  .stat(path.join(state.worktree, item))
                  .pipe(Effect.catch(() => Effect.void))
                  .pipe(
                    Effect.map((stat) => {
                      if (!stat || stat.type !== "File") return
                      const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
                      return size > limit ? item : undefined
                    }),
                  ),
              ),
              { concurrency: 8 },
            )).filter((item): item is string => Boolean(item)),
          )
          const block = new Set(untracked.filter((item) => large.has(item)))
          yield* sync(Array.from(block))
          // Stage only the allowed candidate paths so snapshot updates stay scoped.
          return yield* stage(allow.filter((item) => !block.has(item)))
        })

        const cleanup = Effect.fnUntraced(function* () {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              if (!(yield* exists(state.gitdir))) return
              const result = yield* git(args(["gc", `--prune=${prune}`]), { cwd: state.directory })
              if (result.code !== 0) {
                yield* Effect.logWarning("cleanup failed", {
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return
              }
              yield* Effect.logInfo("cleanup", { prune })
            }),
          )
        })

        const track = Effect.fnUntraced(function* () {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              const existed = yield* exists(state.gitdir)
              yield* fs.ensureDir(state.gitdir).pipe(Effect.orDie)
              if (!existed) {
                yield* git(["init"], {
                  env: { GIT_DIR: state.gitdir, GIT_WORK_TREE: state.worktree },
                })
                yield* git(["--git-dir", state.gitdir, "config", "core.autocrlf", "false"])
                yield* git(["--git-dir", state.gitdir, "config", "core.longpaths", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "core.symlinks", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "core.fsmonitor", "false"])
                // Tuning for very large worktrees so the first add stays bounded.
                yield* git(["--git-dir", state.gitdir, "config", "feature.manyFiles", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "index.version", "4"])
                yield* git(["--git-dir", state.gitdir, "config", "index.threads", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "core.untrackedCache", "true"])
                yield* seed()
                yield* Effect.logInfo("initialized")
              }
              // Do not publish a stale index as a completed capture after a failed scan/stage.
              if (!(yield* add())) return
              const result = yield* git(args(["write-tree"]), { cwd: state.directory })
              const hash = result.text.trim()
              if (result.code !== 0 || !hash) {
                yield* Effect.logWarning("failed to write snapshot tree", {
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return
              }
              yield* Effect.logInfo("tracking", { hash, cwd: state.directory, git: state.gitdir })
              return hash
            }),
          )
        })

        const patch = Effect.fnUntraced(function* (hash: string, completed?: string) {
          return yield* locked(
            Effect.gen(function* () {
              // Compare immutable trees at step completion, even if the worktree or
              // shared index has changed since track(). Undo still uses the original hash.
              // Include both sides of renames so revert can restore the old path.
              const captured = completed
                ? yield* git(
                    [
                      ...quote,
                      ...args([
                        "diff",
                        "--no-ext-diff",
                        "--no-renames",
                        "--name-only",
                        "-z",
                        hash,
                        completed,
                        "--",
                        ".",
                      ]),
                    ],
                    { cwd: state.directory },
                  )
                : undefined
              if (captured && captured.code !== 0) {
                yield* Effect.logWarning("failed to compare snapshot trees, falling back to worktree", {
                  hash,
                  completed,
                  exitCode: captured.code,
                })
              }
              const result =
                captured?.code === 0
                  ? captured
                  : yield* Effect.gen(function* () {
                      yield* add()
                      return yield* git(
                        [
                          ...quote,
                          ...args(["diff", "--cached", "--no-ext-diff", "--name-only", "-z", hash, "--", "."]),
                        ],
                        { cwd: state.directory },
                      )
                    })
              if (result.code !== 0) {
                yield* Effect.logWarning("failed to get diff", { hash, exitCode: result.code })
                return { hash, files: [] }
              }
              const files = result.text.split("\0").filter(Boolean)

              // Hide ignored-file removals from the user-facing patch output.
              const ignored = yield* ignore(files)

              return {
                hash,
                files: files
                  .filter((item) => !ignored.has(item))
                  .map((x) => path.join(state.worktree, x).replaceAll("\\", "/")),
              }
            }),
          )
        })

        const restore = Effect.fnUntraced(function* (snapshot: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* Effect.logInfo("restore", { commit: snapshot })
              const result = yield* git([...core, ...args(["read-tree", snapshot])], { cwd: state.worktree })
              if (result.code === 0) {
                const checkout = yield* git([...core, ...args(["checkout-index", "-a", "-f"])], {
                  cwd: state.worktree,
                })
                if (checkout.code === 0) return
                yield* Effect.logError("failed to restore snapshot", {
                  snapshot,
                  exitCode: checkout.code,
                  stderr: checkout.stderr,
                })
                return
              }
              yield* Effect.logError("failed to restore snapshot", {
                snapshot,
                exitCode: result.code,
                stderr: result.stderr,
              })
            }),
          )
        })

        const revert = Effect.fnUntraced(function* (patches: Patch[]) {
          return yield* locked(
            Effect.gen(function* () {
              const ops: { hash: string; file: string; rel: string }[] = []
              const seen = new Set<string>()
              for (const item of patches) {
                for (const file of item.files) {
                  if (seen.has(file)) continue
                  seen.add(file)
                  ops.push({
                    hash: item.hash,
                    file,
                    rel: path.relative(state.worktree, file).replaceAll("\\", "/"),
                  })
                }
              }

              const single = Effect.fnUntraced(function* (op: (typeof ops)[number]) {
                yield* Effect.logInfo("reverting", { file: op.file, hash: op.hash })
                const result = yield* git([...core, ...args(["checkout", op.hash, "--", op.file])], {
                  cwd: state.worktree,
                })
                if (result.code === 0) return
                const tree = yield* git([...core, ...args(["ls-tree", op.hash, "--", op.rel])], {
                  cwd: state.worktree,
                })
                if (tree.code === 0 && tree.text.trim()) {
                  yield* Effect.logInfo("file existed in snapshot but checkout failed, keeping", {
                    file: op.file,
                    hash: op.hash,
                  })
                  return
                }
                yield* Effect.logInfo("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                yield* remove(op.file)
              })

              const clash = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

              for (let i = 0; i < ops.length; ) {
                const first = ops[i]!
                const run = [first]
                let j = i + 1
                // Only batch adjacent files when their paths cannot affect each other.
                while (j < ops.length && run.length < 100) {
                  const next = ops[j]!
                  if (next.hash !== first.hash) break
                  if (run.some((item) => clash(item.rel, next.rel))) break
                  run.push(next)
                  j += 1
                }

                if (run.length === 1) {
                  yield* single(first)
                  i = j
                  continue
                }

                const tree = yield* git(
                  [...core, ...args(["ls-tree", "--name-only", first.hash, "--", ...run.map((item) => item.rel)])],
                  {
                    cwd: state.worktree,
                  },
                )

                if (tree.code !== 0) {
                  yield* Effect.logInfo("batched ls-tree failed, falling back to single-file revert", {
                    hash: first.hash,
                    files: run.length,
                  })
                  for (const op of run) {
                    yield* single(op)
                  }
                  i = j
                  continue
                }

                const have = new Set(
                  tree.text
                    .trim()
                    .split("\n")
                    .map((item) => item.trim())
                    .filter(Boolean),
                )
                const list = run.filter((item) => have.has(item.rel))
                if (list.length) {
                  yield* Effect.logInfo("reverting", { hash: first.hash, files: list.length })
                  const result = yield* git(
                    [...core, ...args(["checkout", first.hash, "--", ...list.map((item) => item.file)])],
                    {
                      cwd: state.worktree,
                    },
                  )
                  if (result.code !== 0) {
                    yield* Effect.logInfo("batched checkout failed, falling back to single-file revert", {
                      hash: first.hash,
                      files: list.length,
                    })
                    for (const op of run) {
                      yield* single(op)
                    }
                    i = j
                    continue
                  }
                }

                for (const op of run) {
                  if (have.has(op.rel)) continue
                  yield* Effect.logInfo("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                  yield* remove(op.file)
                }

                i = j
              }
            }),
          )
        })

        const diff = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* add()
              const result = yield* git([...quote, ...args(["diff", "--cached", "--no-ext-diff", hash, "--", "."])], {
                cwd: state.worktree,
              })
              if (result.code !== 0) {
                yield* Effect.logWarning("failed to get diff", {
                  hash,
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return ""
              }
              return result.text.trim()
            }),
          )
        })

        const stats = Effect.fnUntraced(function* (from: string, to: string, files: readonly string[]) {
          return yield* locked(
            Effect.gen(function* () {
              const paths = files.map((file) => `:(top,literal)${file}`)
              if (!paths.length) return []
              const flags = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-relative"]
              const statuses = yield* git(
                [...quote, ...args([...flags, "--name-status", "-z", from, to, "--", ...paths])],
                { cwd: state.worktree },
              )
              const counts = yield* git([...quote, ...args([...flags, "--numstat", "-z", from, to, "--", ...paths])], {
                cwd: state.worktree,
              })
              if (statuses.code !== 0 || counts.code !== 0)
                return yield* Effect.die(new Error(statuses.stderr || counts.stderr))
              const entries = statuses.text.split("\0")
              const status = new Map<string, "added" | "deleted" | "modified">()
              for (let i = 0; i + 1 < entries.length; i += 2) {
                status.set(entries[i + 1], entries[i] === "A" ? "added" : entries[i] === "D" ? "deleted" : "modified")
              }
              const ignored = yield* ignore([...status.keys()])
              return counts.text
                .split("\0")
                .filter(Boolean)
                .flatMap((line) => {
                  const [adds, dels, ...name] = line.split("\t")
                  const file = name.join("\t")
                  if (ignored.has(file)) return []
                  return [
                    {
                      file,
                      additions: adds === "-" ? 0 : Number(adds),
                      deletions: dels === "-" ? 0 : Number(dels),
                      status: status.get(file) ?? "modified",
                    },
                  ]
                })
            }),
          )
        })

        const diffFull = Effect.fnUntraced(function* (from: string, to: string) {
          return yield* locked(
            Effect.gen(function* () {
              type Row = {
                file: string
                name: string
                status: "added" | "deleted" | "modified"
                binary: boolean
                additions: number
                deletions: number
              }

              const result: FileDiff[] = []
              const status = new Map<string, "added" | "deleted" | "modified">()
              const objects = new Map<string, string[]>()
              const options = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--no-relative"]

              const statuses = yield* git(
                [...quote, ...args([...options, "--raw", "--no-abbrev", "-z", from, to, "--", "."])],
                { cwd: state.directory },
              )
              if (statuses.code !== 0) return yield* Effect.die(new Error(statuses.stderr))

              const entries = statuses.text.split("\0")
              for (let i = 0; i + 1 < entries.length; i += 2) {
                const [, , before, after, code] = entries[i].split(" ")
                const file = entries[i + 1]
                if (!code || !file) continue
                status.set(file, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified")
                objects.set(
                  file,
                  [before, after].filter((id) => id && !/^0+$/.test(id)),
                )
              }

              const numstat = yield* git([...quote, ...args([...options, "--numstat", from, to, "--", "."])], {
                cwd: state.directory,
              })
              if (numstat.code !== 0) return yield* Effect.die(new Error(numstat.stderr))

              // Preserve the established Git-quoted public names that SessionSummary
              // decodes. The identically ordered raw records supply literal paths
              // for Git, including embedded tabs/newlines and leading quotes.
              const names = Array.from(status.keys())
              const rows = numstat.text
                .split("\n")
                .filter(Boolean)
                .flatMap((line, index) => {
                  const [adds, dels] = line.split("\t", 2)
                  const name = line.slice(adds.length + dels.length + 2)
                  const file = names[index]
                  if (!file) return []
                  const binary = adds === "-" && dels === "-"
                  const additions = binary ? 0 : parseInt(adds)
                  const deletions = binary ? 0 : parseInt(dels)
                  return [
                    {
                      file,
                      name,
                      status: status.get(file) ?? "modified",
                      binary,
                      additions: Number.isFinite(additions) ? additions : 0,
                      deletions: Number.isFinite(deletions) ? deletions : 0,
                    } satisfies Row,
                  ]
                })
              if (rows.length !== names.length) return yield* Effect.die(new Error("Incomplete snapshot stats"))

              // Hide ignored-file removals from the user-facing diff output.
              const ignored = yield* ignore(rows.map((r) => r.file))
              if (ignored.size > 0) {
                const filtered = rows.filter((r) => !ignored.has(r.file))
                rows.length = 0
                rows.push(...filtered)
              }

              if (!rows.length) return result
              // Query sizes by object ID: no blob contents cross into JS, and filenames
              // containing newlines cannot be interpreted as cat-file batch commands.
              const ids = Array.from(new Set(rows.flatMap((row) => (row.binary ? [] : (objects.get(row.file) ?? [])))))
              const sizes = new Map<string, number>()
              if (ids.length) {
                const check = yield* git([...cfg, ...args(["cat-file", "--batch-check=%(objectname) %(objectsize)"])], {
                  stdin: ids.join("\n") + "\n",
                })
                if (check.code !== 0) return yield* Effect.die(new Error(check.stderr))
                for (const line of check.text.trimEnd().split("\n")) {
                  const [id, size] = line.split(" ")
                  sizes.set(id, /^\d+$/.test(size) ? Number(size) : Infinity)
                }
              }

              let eagerBytes = 0
              const planned = rows.map((row) => {
                const bytes = row.binary
                  ? 0
                  : (objects.get(row.file) ?? []).reduce((sum, id) => sum + (sizes.get(id) ?? Infinity), 0)
                const full = bytes <= fullContextFileBytes && eagerBytes + bytes <= fullContextTotalBytes
                if (full) eagerBytes += bytes
                return { ...row, bytes, full }
              })
              for (let i = 0; i < planned.length; ) {
                const first = planned[i]
                const run = [first]
                let bytes = first.bytes
                let next = i + 1
                while (next < planned.length && run.length < 100) {
                  const row = planned[next]
                  if (row.full !== first.full || bytes + row.bytes > diffBatchBytes) break
                  run.push(row)
                  bytes += row.bytes
                  next++
                }
                const text = run.filter((row) => !row.binary)
                const patches = text.length
                  ? yield* git(
                      [
                        ...quote,
                        // Consumers require a context prefix even on blank lines.
                        "-c",
                        "diff.suppressBlankEmpty=false",
                        ...args([
                          ...options,
                          "--patch",
                          `--unified=${first.full ? 2147483647 : 3}`,
                          "--inter-hunk-context=0",
                          "--src-prefix=a/",
                          "--dst-prefix=b/",
                          from,
                          to,
                          "--",
                          ...text.map((row) => `:(top,literal)${row.file}`),
                        ]),
                      ],
                      { cwd: state.worktree },
                    )
                  : undefined
                if (patches && patches.code !== 0) return yield* Effect.die(new Error(patches.stderr))
                // Git quotes embedded newlines in headers; hunk lines always have a
                // prefix. Only real file boundaries can start with "diff --git ".
                const chunks = patches?.text.split(/(?=^diff --git )/m).filter(Boolean) ?? []
                if (chunks.length !== text.length) return yield* Effect.die(new Error("Incomplete snapshot diff"))
                let index = 0
                for (const row of run) {
                  const patch = row.binary ? "" : chunks[index++]
                  const start = patch.indexOf("\n@@ ")
                  result.push({
                    file: row.name,
                    // Ordinary unified patches are already supported as partial by
                    // consumers. Do not give them the full-context Git header marker.
                    patch:
                      row.full || row.binary
                        ? patch
                        : formatPatch({
                            oldFileName: row.name,
                            newFileName: row.name,
                            oldHeader: undefined,
                            newHeader: undefined,
                            hunks: [],
                          }) + (start < 0 ? "" : patch.slice(start + 1)),
                    additions: row.additions,
                    deletions: row.deletions,
                    status: row.status,
                  })
                }
                i = next
              }

              return result
            }),
          )
        })

        yield* cleanup().pipe(
          Effect.catchCause((cause) => Effect.logError("cleanup loop failed", { cause: Cause.pretty(cause) })),
          Effect.repeat(Schedule.spaced(Duration.hours(1))),
          Effect.delay(Duration.minutes(1)),
          Effect.forkScoped,
        )

        return { cleanup, track, patch, restore, revert, diff, stats, diffFull }
      }),
    )

    return Service.of({
      init: Effect.fn("Snapshot.init")(function* () {
        yield* InstanceState.get(state)
      }),
      cleanup: Effect.fn("Snapshot.cleanup")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.cleanup())
      }),
      track: Effect.fn("Snapshot.track")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.track())
      }),
      patch: Effect.fn("Snapshot.patch")(function* (hash: string, completed?: string) {
        return yield* InstanceState.useEffect(state, (s) => s.patch(hash, completed))
      }),
      restore: Effect.fn("Snapshot.restore")(function* (snapshot: string) {
        return yield* InstanceState.useEffect(state, (s) => s.restore(snapshot))
      }),
      revert: Effect.fn("Snapshot.revert")(function* (patches: Patch[]) {
        return yield* InstanceState.useEffect(state, (s) => s.revert(patches))
      }),
      diff: Effect.fn("Snapshot.diff")(function* (hash: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diff(hash))
      }),
      stats: Effect.fn("Snapshot.stats")(function* (from: string, to: string, files: readonly string[]) {
        return yield* InstanceState.useEffect(state, (s) => s.stats(from, to, files))
      }),
      diffFull: Effect.fn("Snapshot.diffFull")(function* (from: string, to: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diffFull(from, to))
      }),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, AppProcess.node, Config.node],
})

export * as Snapshot from "."

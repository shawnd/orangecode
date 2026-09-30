export * as FileSystemSearch from "./search"

import { makeLocationNode } from "../effect/app-node"
import path from "path"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Semaphore } from "effect"
import { Fff } from "#fff"
import fuzzysort from "fuzzysort"
import { Entry, Match } from "@opencode-ai/schema/filesystem"
import type { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { Flag } from "../flag/flag"

export interface Interface {
  readonly find: (input: FileSystem.FindInput) => Effect.Effect<FileSystem.Entry[]>
  readonly glob: (input: FileSystem.GlobInput) => Effect.Effect<readonly FileSystem.Entry[]>
  readonly grep: (input: FileSystem.GrepInput) => Effect.Effect<readonly FileSystem.Match[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileSystem/Search") {}

const makeRipgrep = Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  const location = yield* Location.Service
  const ripgrep = yield* Ripgrep.Service
  const scope = yield* Scope.Scope
  const state = {
    files: [] as string[],
    directories: [] as string[],
  }
  const directories = new Set<string>()
  yield* ripgrep
    .find({
      cwd: location.directory,
      pattern: "*",
      limit: location.vcs ? Number.MAX_SAFE_INTEGER : 100_000,
      onEntry: (entry) =>
        Effect.sync(() => {
          state.files.push(entry.path)
          const parts = entry.path.split("/")
          parts.slice(0, -1).forEach((_, index) => directories.add(parts.slice(0, index + 1).join("/") + path.sep))
        }),
    })
    .pipe(Effect.orDie, Effect.asVoid, Effect.forkIn(scope))
  return Service.of({
    glob: (input) =>
      Effect.gen(function* () {
        const target = path.resolve(location.directory, input.path ?? ".")
        const info = yield* fs.stat(target).pipe(Effect.orDie)
        const cwd = info.type === "File" ? path.dirname(target) : target
        return yield* ripgrep
          .glob({
            cwd,
            pattern: input.pattern,
            limit: input.limit ?? Number.MAX_SAFE_INTEGER,
          })
          .pipe(
            Effect.map((result) =>
              result.map((entry) =>
                Entry.make({
                  ...entry,
                  path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, entry.path))),
                }),
              ),
            ),
            Effect.orDie,
          )
      }),
    grep: (input) =>
      Effect.gen(function* () {
        const target = path.resolve(location.directory, input.path ?? ".")
        const info = yield* fs.stat(target).pipe(Effect.orDie)
        const cwd = info.type === "File" ? path.dirname(target) : target
        return yield* ripgrep
          .grep({
            cwd,
            pattern: input.pattern,
            file: info.type === "File" ? path.basename(target) : undefined,
            include: input.include,
            limit: input.limit ?? Number.MAX_SAFE_INTEGER,
          })
          .pipe(
            Effect.map((result) =>
              result.map((match) =>
                Match.make({
                  ...match,
                  entry: Entry.make({
                    ...match.entry,
                    path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, match.entry.path))),
                  }),
                }),
              ),
            ),
            Effect.orDie,
          )
      }),
    find: (input) =>
      Effect.gen(function* () {
        // The scan remains partial while running. Materialize its append-only
        // directory set only when consumed, not once for every file visited.
        if (input.type !== "file" && state.directories.length !== directories.size) {
          state.directories = Array.from(directories)
        }
        const items =
          input.type === "file"
            ? state.files
            : input.type === "directory"
              ? state.directories
              : [...state.files, ...state.directories]
        return fuzzysort.go(input.query, items, { limit: input.limit ?? 50 }).map((item) => {
          const relative = item.target
          const type = relative.endsWith(path.sep) ? ("directory" as const) : ("file" as const)
          return Entry.make({
            path: RelativePath.make(relative),
            type,
          })
        })
      }),
  })
})

const lazyRipgrep = Effect.gen(function* () {
  const context = yield* Effect.context<FSUtil.Service | Location.Service | Ripgrep.Service | Scope.Scope>()
  return yield* Effect.cached(makeRipgrep.pipe(Effect.provideContext(context)))
})

export const ripgrepLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const service = yield* lazyRipgrep
    return Service.of({
      find: (input) => service.pipe(Effect.flatMap((service) => service.find(input))),
      glob: (input) => service.pipe(Effect.flatMap((service) => service.glob(input))),
      grep: (input) => service.pipe(Effect.flatMap((service) => service.grep(input))),
    })
  }),
)

export const makeFff = (create: (opts: Fff.Init) => Fff.Picker = Fff.create) =>
  Effect.gen(function* () {
    const location = yield* Location.Service
    const fallback = yield* lazyRipgrep
    const picker = create({
      basePath: location.directory,
      aiMode: true,
      disableMmapCache: true,
      disableContentIndexing: true,
    })
    yield* Effect.addFinalizer(() => Effect.promise(() => picker.destroy()))
    const unavailable = { value: false }
    const run = <A>(native: (signal: AbortSignal) => Promise<A>, other: (service: Interface) => Effect.Effect<A>) =>
      Effect.suspend(() =>
        unavailable.value
          ? fallback.pipe(Effect.flatMap(other))
          : Effect.tryPromise({ try: native, catch: (error) => error }).pipe(
              Effect.catch((error) => {
                if (!(error instanceof Fff.FffError) || (error.kind !== "unavailable" && error.kind !== "transport")) {
                  return Effect.die(error)
                }
                const first = !unavailable.value
                unavailable.value = true
                return Effect.gen(function* () {
                  if (first) {
                    yield* Effect.logWarning("fff unavailable; using ripgrep", { kind: error.kind })
                    yield* Effect.promise(() => picker.destroy())
                  }
                  const service = yield* fallback
                  return yield* other(service)
                })
              }),
            ),
      )
    return Service.of({
      glob: (input) =>
        run(
          async (signal) => {
            const prefix = input.path?.replaceAll("\\", "/").replace(/\/$/, "")
            const found = await picker.glob(
              prefix ? `${prefix}/${input.pattern}` : input.pattern,
              {
                pageIndex: 0,
                pageSize: input.limit,
              },
              signal,
            )
            return found.items.map((item) =>
              Entry.make({
                path: RelativePath.make(item.relativePath.replaceAll("\\", "/")),
                type: "file",
              }),
            )
          },
          (service) => service.glob(input),
        ),
      grep: (input) =>
        run(
          async (signal) => {
            const prefix = input.path?.replaceAll("\\", "/").replace(/\/$/, "")
            const found = await picker.grepMatches(
              [prefix ? `${prefix}/**` : undefined, input.include, input.pattern]
                .filter((value) => value !== undefined)
                .join(" "),
              { mode: "regex", pageSize: input.limit, timeBudgetMs: 1_500 },
              signal,
            )
            return materializeMatches(found, signal)
          },
          (service) => service.grep(input),
        ),
      find: (input) =>
        run(
          async (signal) => {
            const options = { pageIndex: 0, pageSize: input.limit ?? 50 }
            const items = await (async () => {
              if (input.type === "file") {
                const found = await picker.fileSearch(input.query.trim(), options, signal)
                return found.items.map((item, index) => ({
                  path: item.relativePath,
                  type: "file" as const,
                  score: found.scores[index]?.total ?? 0,
                }))
              }
              if (input.type === "directory") {
                const found = await picker.directorySearch(input.query.trim(), options, signal)
                return found.items.map((item, index) => ({
                  path: item.relativePath,
                  type: "directory" as const,
                  score: found.scores[index]?.total ?? 0,
                }))
              }
              const found = await picker.mixedSearch(input.query.trim(), options, signal)
              return found.items.map((item, index) => ({
                path: item.item.relativePath,
                type: item.type,
                score: found.scores[index]?.total ?? 0,
              }))
            })()
            return items
              .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
              .map((item) => {
                const relative = item.path.replaceAll("\\", "/").replace(/\/$/, "")
                return Entry.make({
                  path: RelativePath.make(relative + (item.type === "directory" ? path.sep : "")),
                  type: item.type,
                })
              })
          },
          (service) => service.find(input),
        ),
    })
  })

// Only search resources are retired. Location services (runs, jobs, PTYs and
// approvals) keep their existing ownership and lifetime.
export const makeIdle = (make: ReturnType<typeof makeFff>, idleMs: number) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<FSUtil.Service | Location.Service | Ripgrep.Service>()
    const owner = yield* Scope.Scope
    const gate = yield* Semaphore.make(1)
    const state = {
      closed: false,
      current: undefined as
        | { scope: Scope.Closeable; service: Interface; leases: number; drained: Deferred.Deferred<void> }
        | undefined,
      timer: undefined as Fiber.Fiber<void> | undefined,
    }
    const close = Effect.gen(function* () {
      if (!state.current) return
      const entry = state.current
      // Keep the gate until native destruction acknowledges completion. Admission
      // cannot overlap the old index's teardown, even after caller interruption.
      yield* Scope.close(entry.scope, Exit.void).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            state.closed = true
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            state.current = undefined
          }),
        ),
        Effect.ensuring(Deferred.succeed(entry.drained, undefined)),
      )
    })
    yield* Effect.addFinalizer(() =>
      gate
        .withPermit(
          Effect.gen(function* () {
            state.closed = true
            state.timer?.interruptUnsafe()
            const entry = state.current
            if (entry?.leases === 0) yield* close
            return entry?.drained
          }),
        )
        .pipe(Effect.flatMap((drained) => (drained ? Deferred.await(drained) : Effect.void))),
    )
    const borrow = gate
      .withPermit(
        Effect.acquireRelease(
          Effect.gen(function* () {
            if (state.closed) return yield* Effect.interrupt
            state.timer?.interruptUnsafe()
            state.timer = undefined
            if (!state.current) {
              const scope = yield* Scope.make()
              // Captured contexts also contain the owner Scope. Override it inside
              // context provision so picker/fallback finalizers belong to this entry.
              const service = yield* make.pipe(
                Scope.provide(scope),
                Effect.provideContext(context),
                Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
              )
              state.current = { scope, service, leases: 0, drained: yield* Deferred.make<void>() }
            }
            state.current.leases++
            return state.current
          }),
          (entry) =>
            gate.withPermit(
              Effect.gen(function* () {
                entry.leases--
                if (entry.leases) return
                if (state.closed) return yield* close
                const timer = yield* Effect.sleep(idleMs).pipe(
                  Effect.andThen(
                    gate.withPermit(
                      Effect.gen(function* () {
                        if (state.current !== entry || entry.leases || state.timer !== timer) return
                        yield* close
                      }).pipe(Effect.uninterruptible),
                    ),
                  ),
                  Effect.forkIn(owner),
                )
                state.timer = timer
              }),
            ),
        ),
      )
      .pipe(Effect.interruptible)
    const run = <A>(f: (service: Interface) => Effect.Effect<A>) =>
      borrow.pipe(
        Effect.flatMap((entry) => f(entry.service)),
        Effect.scoped,
      )
    return Service.of({
      find: (input) => run((service) => service.find(input)),
      glob: (input) => run((service) => service.glob(input)),
      grep: (input) => run((service) => service.grep(input)),
    })
  })

export const fffLayer = Layer.effect(
  Service,
  Effect.suspend(() => {
    const idleMs = Flag.OPENCODE_EXPERIMENTAL_SEARCH_IDLE_MS
    return idleMs === undefined ? makeFff() : makeIdle(makeFff(), idleMs)
  }),
)

// Schema construction can itself occupy the caller for tens of milliseconds on
// a large page. Yield between small batches without changing order or limits.
export async function materializeMatches(found: Fff.GrepMatches, signal?: AbortSignal) {
  const matches: FileSystem.Match[] = []
  for (let offset = 0; offset < found.length; offset += 128) {
    if (offset) await new Promise<void>((resolve) => setImmediate(resolve))
    signal?.throwIfAborted()
    matches.push(
      ...found.slice(offset, offset + 128).map((match) =>
        Match.make({
          ...match,
          entry: Entry.make({ path: RelativePath.make(match.entry.path), type: "file" }),
        }),
      ),
    )
  }
  return matches
}

const layer = Layer.unwrap(Effect.sync(() => (Flag.OPENCODE_DISABLE_FFF || !Fff.available() ? ripgrepLayer : fffLayer)))

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Location.node, Ripgrep.node] })

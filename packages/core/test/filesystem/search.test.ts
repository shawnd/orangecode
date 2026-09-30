import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit, Fiber, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { FSUtil } from "../../src/fs-util"
import { Location } from "../../src/location"
import { FileSystemSearch } from "../../src/filesystem/search"
import { Fff } from "../../src/filesystem/fff.bun"
import { FffClient } from "../../src/filesystem/fff-client"
import { location } from "../fixture/location"

const it = testEffect(LayerNode.compile(Ripgrep.node))

const withTmp = <A, E, R>(f: (directory: AbsolutePath) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(AbsolutePath.make(tmp.path))))

describe("Ripgrep", () => {
  it.live("globs files as an array", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).glob({ cwd, pattern: "**/*.ts", limit: 10 })
        expect(result.map((item) => item.path)).toEqual([RelativePath.make("src/match.ts")])
      }),
    ),
  )

  it.live("greps files with include filtering", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "skip.txt"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).grep({ cwd, pattern: "needle", include: "*.ts", limit: 10 })
        expect(result).toHaveLength(1)
        expect(result[0]?.entry.path).toBe(RelativePath.make("src/match.ts"))
        expect(result[0]?.submatches[0]?.text).toBe("needle")
      }),
    ),
  )
})

const search = testEffect(Layer.mergeAll(LayerNode.compile(FSUtil.node), LayerNode.compile(Ripgrep.node)))

describe("Location search", () => {
  test("physically missing native import uses real ripgrep in both native modes", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "isolated"))
    await Bun.write(path.join(tmp.path, "match.txt"), "missing_import_needle\n")
    const source = new URL("../../src/filesystem/", import.meta.url)
    for (const name of ["fff.bun.ts", "fff-client.ts", "fff-pool.ts", "fff.worker.ts"]) {
      await Bun.write(path.join(tmp.path, "isolated", name), await Bun.file(new URL(name, source)).text())
    }
    // Share error identity with the real service while resolving the native
    // package from an isolated directory with no node_modules. No native stub.
    await Bun.write(
      path.join(tmp.path, "isolated", "fff-types.ts"),
      `export { FffError, formatGrep, workerConfig } from ${JSON.stringify(new URL("fff-types.ts", source).pathname)}`,
    )
    for (const factory of ["createDirect", "createWorker"]) {
      const child = Bun.spawn(
        [
          "timeout",
          "--signal=KILL",
          "15s",
          process.execPath,
          "--no-install",
          "-e",
          `
        import assert from "node:assert/strict"
        import { Effect, Layer } from ${JSON.stringify(import.meta.resolve("effect"))}
        import { FileSystemSearch } from ${JSON.stringify(new URL("../../src/filesystem/search.ts", import.meta.url).pathname)}
        import { FSUtil } from ${JSON.stringify(new URL("../../src/fs-util.ts", import.meta.url).pathname)}
        import { Ripgrep } from ${JSON.stringify(new URL("../../src/ripgrep.ts", import.meta.url).pathname)}
        import { Location } from ${JSON.stringify(new URL("../../src/location.ts", import.meta.url).pathname)}
        import { LayerNode } from ${JSON.stringify(new URL("../../src/effect/layer-node.ts", import.meta.url).pathname)}
        import { location } from ${JSON.stringify(new URL("../fixture/location.ts", import.meta.url).pathname)}
        import { Fff } from ${JSON.stringify(path.join(tmp.path, "isolated", "fff.bun.ts"))}
        const client = Fff.${factory}({basePath: ${JSON.stringify(tmp.path)}, aiMode:true, disableMmapCache:true, disableContentIndexing:true})
        await assert.rejects(client.waitForScan(5000), error => error.kind === "unavailable")
        await Effect.runPromise(Effect.gen(function* () {
          const service = yield* FileSystemSearch.makeFff(() => client)
          const matches = yield* service.grep({pattern:"missing_import_needle", include:"match.txt"})
          assert.equal(matches.length, 1)
          assert.equal(matches[0].entry.path, "match.txt")
          assert.equal(client.state.backend, undefined)
        }).pipe(Effect.scoped,
          Effect.provideService(Location.Service, location({directory:${JSON.stringify(tmp.path)}})),
          Effect.provide(Layer.mergeAll(LayerNode.compile(FSUtil.node), LayerNode.compile(Ripgrep.node)))))
        console.log("MISSING_NATIVE_IMPORT_RIPGREP_OK")
      `,
        ],
        { cwd: tmp.path, env: { ...process.env, BUN_INSTALL_AUTO: "disable" }, stdout: "pipe", stderr: "pipe" },
      )
      const result = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(result[2], result[1]).toBe(0)
      expect(result[0]).toContain("MISSING_NATIVE_IMPORT_RIPGREP_OK")
    }
  }, 35000)

  search.live("selected backend returns actual matches", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(path.join(directory, "match.txt"), "selected_backend_needle\n"))
        yield* Effect.gen(function* () {
          const service = yield* FileSystemSearch.Service
          const deadline = Date.now() + 3000
          while (!(yield* service.grep({ pattern: "selected_backend_needle" })).length && Date.now() < deadline) {
            yield* Effect.sleep(10)
          }
          const matches = yield* service.grep({ pattern: "selected_backend_needle" })
          expect(matches.map((x) => x.entry.path)).toEqual([RelativePath.make("match.txt")])
        }).pipe(Effect.provide(FileSystemSearch.locationLayer))
      }).pipe(Effect.provideService(Location.Service, location({ directory }))),
    ),
  )

  for (const failure of ["startup", "direct initialization", "worker initialization"] as const) {
    search.live(`real ripgrep fallback after ${failure} failure`, () =>
      withTmp((directory) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(path.join(directory, "src/match.ts"), "é🙂 needle\n"))
          const service = yield* FileSystemSearch.makeFff((opts) =>
            failure === "startup"
              ? new FffClient(opts, () => new Worker(`${directory}/missing-worker.ts`))
              : failure === "direct initialization"
                ? Fff.createDirect({ ...opts, basePath: `${directory}/missing-directory` })
                : Fff.createWorker({ ...opts, basePath: `${directory}/missing-directory` }),
          )
          const cohort = yield* Effect.forEach(
            Array.from({ length: 40 }),
            () => service.grep({ pattern: "needle", include: "*.ts", limit: 10 }),
            { concurrency: "unbounded" },
          )
          expect(cohort.every((matches) => matches.length === 1)).toBe(true)
          const matches = cohort[0]
          expect(matches[0]?.entry.path).toBe(RelativePath.make("src/match.ts"))
          expect(matches[0]?.submatches[0]).toEqual({ text: "needle", start: 7, end: 13 })
          expect((yield* service.glob({ pattern: "**/*.ts" })).map((x) => x.path)).toEqual([
            RelativePath.make("src/match.ts"),
          ])
          // The fallback scan intentionally publishes partial results, just as before.
          const deadline = Date.now() + 3000
          while (!(yield* service.find({ query: "match" })).length && Date.now() < deadline) yield* Effect.sleep(10)
          expect((yield* service.find({ query: "match", type: "file" })).map((x) => x.path)).toEqual([
            RelativePath.make("src/match.ts"),
          ])
          expect((yield* service.find({ query: "src", type: "directory" })).map((x) => x.path)).toEqual([
            RelativePath.make("src/"),
          ])
        }).pipe(Effect.provideService(Location.Service, location({ directory }))),
      ),
    )
  }

  search.live("service is lazy, preserves ranking/materialization and interruption", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(path.join(directory, "src/match.ts"), "é🙂 needle\n"))
        const picker = Fff.create({
          basePath: directory,
          aiMode: true,
          disableMmapCache: true,
          disableContentIndexing: true,
        })
        const service = yield* FileSystemSearch.makeFff(() => picker)
        expect(picker.state.started).toBe(false)
        expect(yield* Effect.promise(() => picker.waitForScan(5000))).toBe(true)
        expect((yield* service.find({ query: " match ", type: "file", limit: 1 })).map((x) => x.path)).toEqual([
          RelativePath.make("src/match.ts"),
        ])
        expect(
          (yield* service.glob({ pattern: "*.ts", path: RelativePath.make("src"), limit: 1 })).map((x) => x.path),
        ).toEqual([RelativePath.make("src/match.ts")])
        const matches = yield* service.grep({
          pattern: "needle",
          path: RelativePath.make("src"),
          include: "*.ts",
          limit: 1,
        })
        expect(matches[0]?.submatches).toEqual([{ text: "needle", start: 7, end: 13 }])
        expect(Exit.isFailure(yield* service.glob({ pattern: "" }).pipe(Effect.exit))).toBe(true)
        expect(picker.state.closing).toBe(false)
        const fiber = yield* service.grep({ pattern: "needle" }).pipe(Effect.forkScoped)
        yield* Fiber.interrupt(fiber)
        expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
        expect(yield* service.grep({ pattern: "needle" })).toHaveLength(1)
      }).pipe(Effect.provideService(Location.Service, location({ directory }))),
    ),
  )
})

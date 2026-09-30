import { expect } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Exit, Fiber } from "effect"
import { LSP } from "@/lsp/lsp"
import { TestInstance } from "../fixture/fixture"
import { config, execute, layer, observe, patch } from "../fixture/patch-diagnostics"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(layer)

it.instance(
  "bounds concurrent document waits, retains every error, and uses current versions",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const lsp = yield* LSP.Service
      const observed = observe(lsp)
      const result = yield* execute(patch(12)).pipe(Effect.provideService(LSP.Service, observed.service))
      expect(observed.stats).toEqual({ touches: 12, waits: 12, active: 0, peak: 8, completed: 12, interrupted: 0 })
      expect(Object.keys(result.metadata.diagnostics)).toHaveLength(12)
      expect(result.metadata.files).toHaveLength(12)
      const before = yield* lsp.hover({
        file: path.join(instance.directory, "file-0.patchprobe"),
        line: 0,
        character: 0,
      })
      const versions = new Map<string, number>(
        before[0].documents.map((document: { uri: string; version: number }) => [document.uri, document.version]),
      )
      expect(new Set(versions.values()).size).toBe(12)
      for (let i = 0; i < 12; i++) {
        expect(result.output).toContain(`LSP errors detected in file-${i}.patchprobe`)
        const version = versions.get(pathToFileURL(path.join(instance.directory, `file-${i}.patchprobe`)).href)
        expect(version).toBeGreaterThanOrEqual(0)
        expect(result.output).toContain(`checked version ${version}: value ${i}`)
        expect(
          yield* Effect.promise(() => Bun.file(path.join(instance.directory, `file-${i}.patchprobe`)).text()),
        ).toBe(`value ${i}\n`)
      }
      const updated = yield* execute(
        "*** Begin Patch\n*** Update File: file-0.patchprobe\n@@\n-value 0\n+changed\n*** End Patch",
      )
      expect(updated.output).toMatch(/checked version \d+: changed/)
      expect(updated.output).not.toContain(": value 0")
      const server = yield* lsp.hover({
        file: path.join(instance.directory, "file-0.patchprobe"),
        line: 0,
        character: 0,
      })
      expect(server[0].initialize).toBe(1)
      expect(server[0].opens).toBe(12)
      expect(server[0].changes).toBe(1)
      const changed = server[0].documents.find(
        (document: { uri: string }) =>
          document.uri === pathToFileURL(path.join(instance.directory, "file-0.patchprobe")).href,
      )
      expect(changed.version).toBeGreaterThan(Math.max(...versions.values()))
      expect(updated.output).toContain(`checked version ${changed.version}: changed`)
    }),
  { git: true, config: config("slow") },
)

it.instance(
  "serializes repeated normalized targets without changing patch metadata",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const lsp = yield* LSP.Service
      const observed = observe(lsp)
      const result = yield* execute(
        "*** Begin Patch\n*** Add File: repeated.patchprobe\n+first\n*** Add File: ./repeated.patchprobe\n+last\n*** End Patch",
      ).pipe(Effect.provideService(LSP.Service, observed.service))
      expect(result.metadata.files).toHaveLength(2)
      expect(observed.stats.touches).toBe(2)
      expect(observed.stats.peak).toBe(1)
      const server = yield* lsp.hover({
        file: path.join(instance.directory, "repeated.patchprobe"),
        line: 0,
        character: 0,
      })
      expect(server[0].opens).toBe(1)
      expect(server[0].changes).toBe(0)
      expect(server[0].documents).toHaveLength(1)
      expect(server[0].documents[0].text).toBe("last\n")
      expect(server[0].documents[0].version).toBeGreaterThanOrEqual(0)
      expect(result.output).toContain(`checked version ${server[0].documents[0].version}: last`)
    }),
  { git: true, config: config("responsive") },
)

it.instance(
  "touches move destinations and additions, never deleted files or move sources",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(instance.directory, "old.patchprobe"), "old\n"))
      yield* Effect.promise(() => Bun.write(path.join(instance.directory, "deleted.patchprobe"), "gone\n"))
      const lsp = yield* LSP.Service
      const observed = observe(lsp)
      const result = yield* execute(
        "*** Begin Patch\n*** Update File: old.patchprobe\n*** Move to: moved.patchprobe\n@@\n-old\n+new\n*** Delete File: deleted.patchprobe\n*** Add File: added.patchprobe\n+added\n*** End Patch",
      ).pipe(Effect.provideService(LSP.Service, observed.service))
      expect(observed.stats.touches).toBe(2)
      expect(result.metadata.files.map((file) => file.type)).toEqual(["move", "delete", "add"])
      expect(result.output).toContain("M moved.patchprobe\nD deleted.patchprobe\nA added.patchprobe")
      expect(result.output).toMatch(/checked version \d+: new/)
      expect(Object.keys(result.metadata.diagnostics).sort()).toEqual([
        path.join(instance.directory, "added.patchprobe"),
        path.join(instance.directory, "moved.patchprobe"),
      ])
      expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "old.patchprobe")).exists())).toBe(
        false,
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "deleted.patchprobe")).exists())).toBe(
        false,
      )
    }),
  { git: true, config: config("responsive") },
)

it.instance(
  "interruption stops the batch and never starts queued touches or returns partial success",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const lsp = yield* LSP.Service
      const observed = observe(lsp)
      const reads = { diagnostics: 0 }
      const fiber = yield* execute(patch(12)).pipe(
        Effect.provideService(LSP.Service, {
          ...observed.service,
          diagnostics: () =>
            Effect.gen(function* () {
              reads.diagnostics++
              return yield* lsp.diagnostics()
            }),
        }),
        Effect.forkScoped,
      )
      yield* pollWithTimeout(
        Effect.sync(() => (observed.stats.active === 8 ? true : undefined)),
        "waits did not start",
      )
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const server = yield* lsp.hover({
            file: path.join(instance.directory, "file-0.patchprobe"),
            line: 0,
            character: 0,
          })
          return server[0].opens === 8 ? true : undefined
        }),
        "server did not receive the first batch",
      )
      yield* Fiber.interrupt(fiber)
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
      expect(observed.stats).toEqual({ touches: 8, waits: 8, active: 0, peak: 8, completed: 0, interrupted: 8 })
      expect(reads.diagnostics).toBe(0)
      // Writes precede diagnostic collection, including the four not-yet-touched files.
      expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "file-11.patchprobe")).text())).toBe(
        "value 11\n",
      )
      const server = yield* lsp.hover({
        file: path.join(instance.directory, "file-0.patchprobe"),
        line: 0,
        character: 0,
      })
      expect(server[0].initialize).toBe(1)
      expect(server[0].opens).toBe(8)
    }),
  { config: config("none") },
)

it.instance(
  "a silent server still receives every document and waits before successful completion",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const lsp = yield* LSP.Service
      const observed = observe(lsp)
      const started = performance.now()
      const result = yield* execute(patch(4)).pipe(Effect.provideService(LSP.Service, observed.service))
      expect(performance.now() - started).toBeGreaterThan(4_900)
      expect(observed.stats).toEqual({ touches: 4, waits: 4, active: 0, peak: 4, completed: 4, interrupted: 0 })
      expect(result.metadata.diagnostics).toEqual({})
      expect(result.output).toContain("Success. Updated the following files")
      const server = yield* lsp.hover({
        file: path.join(instance.directory, "file-0.patchprobe"),
        line: 0,
        character: 0,
      })
      expect(server[0].opens).toBe(4)
      expect(server[0].published).toBe(0)
    }),
  { config: config("none") },
  15_000,
)

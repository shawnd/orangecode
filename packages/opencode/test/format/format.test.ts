import { NodeFileSystem } from "@effect/platform-node"
import { describe, expect, spyOn } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { provideTmpdirInstance, testInstanceStoreLayer, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Format } from "../../src/format"
import * as Formatter from "../../src/format/formatter"
import { InstanceStore } from "../../src/project/instance-store"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Format.node, CrossSpawnSpawner.node])), NodeFileSystem.layer),
)

describe("Format", () => {
  it.instance("status() returns empty list when no formatters are configured", () =>
    Format.Service.use((fmt) =>
      Effect.gen(function* () {
        expect(yield* fmt.status()).toEqual([])
      }),
    ),
  )

  it.instance(
    "status() returns built-in formatters when formatter is true",
    () =>
      Format.Service.use((fmt) =>
        Effect.gen(function* () {
          const statuses = yield* fmt.status()
          const gofmt = statuses.find((item) => item.name === "gofmt")
          expect(gofmt).toBeDefined()
          expect(gofmt!.extensions).toContain(".go")
        }),
      ),
    { config: { formatter: true } },
  )

  it.instance(
    "status() keeps built-in formatters when config object is provided",
    () =>
      Format.Service.use((fmt) =>
        Effect.gen(function* () {
          const statuses = yield* fmt.status()
          const gofmt = statuses.find((item) => item.name === "gofmt")
          const mix = statuses.find((item) => item.name === "mix")
          expect(gofmt).toBeDefined()
          expect(gofmt!.extensions).toContain(".go")
          expect(mix).toBeDefined()
        }),
      ),
    { config: { formatter: { gofmt: {} } } },
  )

  it.instance(
    "status() excludes formatters marked as disabled in config",
    () =>
      Format.Service.use((fmt) =>
        Effect.gen(function* () {
          const statuses = yield* fmt.status()
          const gofmt = statuses.find((item) => item.name === "gofmt")
          const mix = statuses.find((item) => item.name === "mix")
          expect(gofmt).toBeUndefined()
          expect(mix).toBeDefined()
        }),
      ),
    { config: { formatter: { gofmt: { disabled: true } } } },
  )

  it.instance(
    "status() excludes uv when ruff is disabled",
    () =>
      Format.Service.use((fmt) =>
        Effect.gen(function* () {
          const statuses = yield* fmt.status()
          expect(statuses.find((item) => item.name === "ruff")).toBeUndefined()
          expect(statuses.find((item) => item.name === "uv")).toBeUndefined()
        }),
      ),
    { config: { formatter: { ruff: { disabled: true } } } },
  )

  it.instance(
    "status() excludes ruff when uv is disabled",
    () =>
      Format.Service.use((fmt) =>
        Effect.gen(function* () {
          const statuses = yield* fmt.status()
          expect(statuses.find((item) => item.name === "ruff")).toBeUndefined()
          expect(statuses.find((item) => item.name === "uv")).toBeUndefined()
        }),
      ),
    { config: { formatter: { uv: { disabled: true } } } },
  )

  it.instance("service initializes without error", () => Format.Service.use(() => Effect.void))

  it.instance(
    "file() returns false when no formatter runs",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = `${test.directory}/test.txt`
        yield* Effect.promise(() => Bun.write(file, "x"))

        const formatted = yield* Format.use.file(file)
        expect(formatted).toBe(false)
      }),
    { config: { formatter: false } },
  )

  testEffect(
    Layer.mergeAll(
      LayerNode.compile(LayerNode.group([Format.node, CrossSpawnSpawner.node])),
      NodeFileSystem.layer,
      testInstanceStoreLayer,
    ),
  ).live("status() initializes formatter state per directory", () =>
    Effect.gen(function* () {
      const a = yield* provideTmpdirInstance(() => Format.use.status(), {
        config: { formatter: false },
      })
      const b = yield* provideTmpdirInstance(() => Format.use.status(), {
        config: {
          formatter: true,
        },
      })

      expect(a).toEqual([])
      expect(b.find((item) => item.name === "gofmt")).toBeDefined()
    }),
  )

  it.instance(
    "runs enabled checks for matching formatters in parallel",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = `${test.directory}/test.parallel`
        yield* Effect.promise(() => Bun.write(file, "x"))

        const one = {
          extensions: Formatter.gofmt.extensions,
          enabled: Formatter.gofmt.enabled,
        }
        const two = {
          extensions: Formatter.mix.extensions,
          enabled: Formatter.mix.enabled,
        }

        let active = 0
        let max = 0

        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            Formatter.gofmt.extensions = [".parallel"]
            Formatter.mix.extensions = [".parallel"]
            Formatter.gofmt.enabled = async () => {
              active++
              max = Math.max(max, active)
              await Promise.resolve()
              active--
              return ["sh", "-c", "true"]
            }
            Formatter.mix.enabled = async () => {
              active++
              max = Math.max(max, active)
              await Promise.resolve()
              active--
              return ["sh", "-c", "true"]
            }
          }),
          () =>
            Format.Service.use((fmt) =>
              Effect.gen(function* () {
                yield* fmt.init()
                yield* fmt.file(file)
              }),
            ),
          () =>
            Effect.sync(() => {
              Formatter.gofmt.extensions = one.extensions
              Formatter.gofmt.enabled = one.enabled
              Formatter.mix.extensions = two.extensions
              Formatter.mix.enabled = two.enabled
            }),
        )

        expect(max).toBe(2)
      }),
    { config: { formatter: { gofmt: {}, mix: {} } } },
  )

  it.instance(
    "shares missing discovery across concurrent files and status until a newly installed formatter can be discovered",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fmt = yield* Format.Service
        const file = `${test.directory}/test.go`
        const marker = `${test.directory}/installed`
        yield* Effect.promise(() => Bun.write(file, "original"))
        const enabled = spyOn(Formatter.gofmt, "enabled").mockImplementation(async () => {
          if (!(await Bun.file(marker).exists())) return false
          return ["sh", "-c", 'printf formatted > "$1"', "formatter", "$FILE"]
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => enabled.mockRestore()))

        const results = yield* Effect.all([fmt.status(), ...Array.from({ length: 20 }, () => fmt.file(file))], {
          concurrency: "unbounded",
        })
        expect(results.slice(1)).toEqual(Array(20).fill(false))
        expect(enabled).toHaveBeenCalledTimes(1)
        yield* Effect.promise(() => Bun.write(marker, "installed"))
        expect(yield* fmt.file(file)).toBe(false)
        expect((yield* fmt.status()).find((item) => item.name === "gofmt")?.enabled).toBe(false)
        expect(enabled).toHaveBeenCalledTimes(1)

        yield* TestClock.adjust("6 seconds")
        expect(yield* fmt.file(file)).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("formatted")
        expect((yield* fmt.status()).find((item) => item.name === "gofmt")?.enabled).toBe(true)
        expect(enabled).toHaveBeenCalledTimes(2)
        yield* TestClock.adjust("1 minute")
        expect(yield* fmt.file(file)).toBe(true)
        expect(enabled).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(TestClock.layer())),
    { config: { formatter: true } },
  )

  it.instance(
    "shares successful discovery without skipping any concurrent file formatting",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fmt = yield* Format.Service
        const file = `${test.directory}/test.go`
        yield* Effect.promise(() => Bun.write(file, ""))
        const enabled = spyOn(Formatter.gofmt, "enabled").mockImplementation(async () => {
          await Promise.resolve()
          return ["sh", "-c", 'printf x >> "$1"', "formatter", "$FILE"]
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => enabled.mockRestore()))
        expect(
          yield* Effect.forEach(Array.from({ length: 12 }), () => fmt.file(file), {
            concurrency: "unbounded",
          }),
        ).toEqual(Array(12).fill(true))
        expect(enabled).toHaveBeenCalledTimes(1)
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("x".repeat(12))
      }),
    { config: { formatter: true } },
  )

  it.instance(
    "retries failed discovery immediately",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fmt = yield* Format.Service
        const enabled = spyOn(Formatter.gofmt, "enabled")
          .mockRejectedValueOnce(new Error("temporary discovery failure"))
          .mockResolvedValue(false)
        yield* Effect.addFinalizer(() => Effect.sync(() => enabled.mockRestore()))
        expect(Exit.isFailure(yield* Effect.exit(fmt.file(`${test.directory}/one.go`)))).toBe(true)
        expect(yield* fmt.file(`${test.directory}/two.go`)).toBe(false)
        expect(enabled).toHaveBeenCalledTimes(2)
        expect(yield* fmt.file(`${test.directory}/three.go`)).toBe(false)
        expect(enabled).toHaveBeenCalledTimes(2)
      }),
    { config: { formatter: true } },
  )

  it.instance(
    "retries discovery after its caller is interrupted",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fmt = yield* Format.Service
        const started = Promise.withResolvers<void>()
        const pending = Promise.withResolvers<false>()
        const enabled = spyOn(Formatter.gofmt, "enabled")
          .mockImplementationOnce(() => {
            started.resolve()
            return pending.promise
          })
          .mockResolvedValue(false)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            pending.resolve(false)
            enabled.mockRestore()
          }),
        )
        const fiber = yield* fmt.file(`${test.directory}/one.go`).pipe(Effect.forkChild)
        yield* Effect.promise(() => started.promise)
        yield* Fiber.interrupt(fiber)
        expect(yield* fmt.file(`${test.directory}/two.go`)).toBe(false)
        expect(enabled).toHaveBeenCalledTimes(2)
      }),
    { config: { formatter: true } },
  )

  it.instance(
    "disposal clears negative discovery and reload respects manually disabled formatters",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fmt = yield* Format.Service
        const store = yield* InstanceStore.Service
        const enabled = spyOn(Formatter.gofmt, "enabled").mockResolvedValue(false)
        yield* Effect.addFinalizer(() => Effect.sync(() => enabled.mockRestore()))
        expect(yield* fmt.file(`${test.directory}/one.go`)).toBe(false)
        expect(enabled).toHaveBeenCalledTimes(1)
        yield* store.reload({ directory: test.directory })
        expect(yield* fmt.file(`${test.directory}/two.go`)).toBe(false)
        expect(enabled).toHaveBeenCalledTimes(2)
        yield* Effect.promise(() =>
          Bun.write(`${test.directory}/opencode.json`, JSON.stringify({ formatter: { gofmt: { disabled: true } } })),
        )
        yield* store.reload({ directory: test.directory })
        expect(yield* fmt.file(`${test.directory}/three.go`)).toBe(false)
        expect((yield* fmt.status()).find((item) => item.name === "gofmt")).toBeUndefined()
        expect(enabled).toHaveBeenCalledTimes(2)
      }),
    { config: { formatter: true } },
  )

  it.instance(
    "runs matching formatters sequentially for the same file",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = `${test.directory}/test.seq`
        yield* Effect.promise(() => Bun.write(file, "x"))

        yield* Format.Service.use((fmt) =>
          Effect.gen(function* () {
            yield* fmt.init()
            expect(yield* fmt.file(file)).toBe(true)
          }),
        )

        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("xAB")
      }),
    {
      config: {
        formatter: {
          first: {
            command: [
              "node",
              "-e",
              "const fs = require('fs'); const file = process.argv[1]; fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + 'A')",
              "$FILE",
            ],
            extensions: [".seq"],
          },
          second: {
            command: [
              "node",
              "-e",
              "const fs = require('fs'); const file = process.argv[1]; fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + 'B')",
              "$FILE",
            ],
            extensions: [".seq"],
          },
        },
      },
    },
  )
})

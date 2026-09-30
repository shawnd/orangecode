import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { TestInstance } from "../fixture/fixture"
import { config, execute, layer, patch } from "../fixture/patch-diagnostics"
import { testEffect } from "../lib/effect"

const it = testEffect(layer)

it.instance(
  "retains every affected file's diagnostics when a patch exceeds the LSP open-document budget",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const result = yield* execute(patch(80))
      expect(Object.keys(result.metadata.diagnostics)).toHaveLength(80)
      expect(result.metadata.files).toHaveLength(80)
      for (let i = 0; i < 80; i++) {
        const diagnostics = result.metadata.diagnostics[path.join(instance.directory, `file-${i}.patchprobe`)]
        expect(diagnostics).toHaveLength(1)
        expect(diagnostics[0].message).toMatch(new RegExp(`checked version \\d+: value ${i}$`))
      }
    }),
  { git: true, config: config("responsive") },
  30_000,
)

it.instance(
  "collects oversized document diagnostics from both fast and slow servers",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const result = yield* execute(
        [
          "*** Begin Patch",
          ...Array.from(
            { length: 3 },
            (_, i) => `*** Add File: large-${i}.patchprobe\n+value ${i}\n+${"x".repeat(4 * 1024 * 1024 + 1)}`,
          ),
          "*** End Patch",
        ].join("\n"),
      )
      expect(Object.keys(result.metadata.diagnostics)).toEqual(
        Array.from({ length: 3 }, (_, i) => path.join(instance.directory, `large-${i}.patchprobe`)),
      )
      for (let i = 0; i < 3; i++) {
        expect(Bun.file(path.join(instance.directory, `large-${i}.patchprobe`)).size).toBeGreaterThan(4 * 1024 * 1024)
        const diagnostics = result.metadata.diagnostics[path.join(instance.directory, `large-${i}.patchprobe`)]
        expect(diagnostics).toHaveLength(2)
        for (const diagnostic of diagnostics) {
          expect(diagnostic.message).toMatch(new RegExp(`checked version \\d+: value ${i}$`))
        }
      }
    }),
  {
    config: {
      ...config("responsive"),
      lsp: {
        ...config("responsive").lsp,
        "patch-slow": config("slow").lsp["patch-probe"],
      },
    },
  },
  30_000,
)

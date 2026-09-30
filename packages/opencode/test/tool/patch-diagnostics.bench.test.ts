import { afterAll, expect } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { LSP } from "@/lsp/lsp"
import { TestInstance } from "../fixture/fixture"
import { config, execute, layer, observe, patch } from "../fixture/patch-diagnostics"
import { testEffect } from "../lib/effect"

const it = testEffect(layer)
const enabled = process.env.PATCH_DIAGNOSTICS_BENCH === "1"
const results: unknown[] = []
const lockWaitMs = Date.now() - Number(process.env.BENCH_REQUESTED_AT ?? Date.now())
const counts = [1, 4, 12]

if (enabled) {
  it.instance("patch diagnostics warmup", () => execute(patch(1)), { config: config("responsive") })
  for (const mode of ["responsive", "slow", "none"]) {
    for (const count of counts) {
      for (const trial of [1, 2]) {
        it.instance(
          `patch diagnostics benchmark ${mode} ${count} trial ${trial}`,
          () =>
            Effect.gen(function* () {
              const instance = yield* TestInstance
              const lsp = yield* LSP.Service
              const observed = observe(lsp)
              const input = patch(count)
              const started = performance.now()
              const result = yield* execute(input).pipe(Effect.provideService(LSP.Service, observed.service))
              const wallMs = performance.now() - started
              const server = yield* lsp.hover({
                file: path.join(instance.directory, "file-0.patchprobe"),
                line: 0,
                character: 0,
              })
              expect(observed.stats.touches).toBe(count)
              expect(observed.stats.waits).toBe(count)
              expect(observed.stats.active).toBe(0)
              expect(server[0].initialize).toBe(1)
              expect(server[0].opens).toBe(count)
              expect(server[0].watched).toBe(count)
              expect(server[0].changes).toBe(0)
              const versions = new Set<number>()
              for (const document of server[0].documents) {
                versions.add(document.version)
                if (mode !== "none") {
                  expect(result.metadata.diagnostics[fileURLToPath(document.uri)]?.[0]?.message).toBe(
                    `checked version ${document.version}: ${document.text.trim()}`,
                  )
                }
              }
              expect(versions.size).toBe(count)
              expect(Object.keys(result.metadata.diagnostics)).toHaveLength(mode === "none" ? 0 : count)
              const row = {
                mode,
                count,
                trial,
                wallMs,
                patchBytes: Buffer.byteLength(input),
                ...observed.stats,
                server: server[0],
              }
              results.push(row)
              console.log(JSON.stringify(row))
            }),
          { config: config(mode) },
          120_000,
        )
      }
    }
  }
  afterAll(async () => {
    if (!process.env.PATCH_DIAGNOSTICS_OUTPUT) return
    await Bun.write(process.env.PATCH_DIAGNOSTICS_OUTPUT, JSON.stringify({ lockWaitMs, results }, null, 2))
  })
}

import { expect } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Effect, Layer } from "effect"
import { Gopls, KotlinLS, CSharp, FSharp, SourceKit, TerraformLS, HLS } from "@/lsp/server"
import { InstanceState } from "@/effect/instance-state"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

for (const [server, marker, extension] of [
  [Gopls, "go.mod", ".go"],
  [KotlinLS, "build.gradle.kts", ".kt"],
  [KotlinLS, "pom.xml", ".kt"],
  [CSharp, "App.csproj", ".cs"],
  [FSharp, "App.fsproj", ".fs"],
  [SourceKit, "App.xcodeproj", ".swift"],
  [TerraformLS, "main.tf", ".tf"],
  [HLS, "app.cabal", ".hs"],
] as const) {
  it.instance(`${server.id} discovers a nested ${marker} root`, () =>
    Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      const root = path.join((yield* TestInstance).directory, "nested")
      yield* Effect.promise(() => fs.mkdir(path.join(root, "src"), { recursive: true }))
      yield* Effect.promise(async () => {
        if (marker.endsWith("xcodeproj")) return fs.mkdir(path.join(root, marker))
        await Bun.write(path.join(root, marker), "")
      })
      expect(yield* Effect.promise(() => server.root(path.join(root, "src", `file${extension}`), ctx))).toBe(root)
    }),
  )
}

it.instance("gopls prefers go.work over a nested module", () =>
  Effect.gen(function* () {
    const ctx = yield* InstanceState.context
    const root = (yield* TestInstance).directory
    yield* Effect.promise(() => Bun.write(path.join(root, "go.work"), ""))
    yield* Effect.promise(() => Bun.write(path.join(root, "module", "go.mod"), ""))
    expect(yield* Effect.promise(() => Gopls.root(path.join(root, "module", "file.go"), ctx))).toBe(root)
  }),
)

import { Effect, Layer, ManagedRuntime } from "effect"
import { FileFinder } from "@ff-labs/fff-bun"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FileSystemSearch } from "@opencode-ai/core/filesystem/search"
import { Fff } from "@opencode-ai/core/filesystem/fff.bun"

const dir = AbsolutePath.make(process.cwd())

const FILE_QUERIES = ["fff", "package.json", "tools/ experiment"]
const GREP_QUERIES = ["FileFinder", "import", "grep", "autocomplete"]
const GLOB_QUERIES = ["**/*.test.ts"]

const FILE_LIMIT = 100
const GREP_LIMIT = 50
const GLOB_LIMIT = 50

const servicePicker = Promise.withResolvers<Fff.Picker>()
const runtime = ManagedRuntime.make(
  LayerNode.compile(FileSystem.node, [
    [Location.node, Location.boundNode(Location.Ref.make({ directory: dir }))],
    [
      FileSystemSearch.node,
      {
        ...FileSystemSearch.node,
        implementation: Layer.effect(
          FileSystemSearch.Service,
          FileSystemSearch.makeFff((options) => {
            const picker = Fff.createWorker(options)
            servicePicker.resolve(picker)
            return picker
          }),
        ),
      },
    ],
  ]),
)
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.Service>) => runtime.runPromise(effect)

// --- raw Fff picker ---
const t0 = performance.now()
const made = FileFinder.create({ basePath: dir, aiMode: true })
if (!made.ok) {
  console.error("FileFinder.create failed:", made.error)
  process.exit(1)
}
const picker = made.value
console.log(`picker create: ${(performance.now() - t0).toFixed(1)}ms`)

const tw = performance.now()
const ready = await picker.waitForScan(2_500)
if (!ready.ok || ready.value !== true) throw new Error("raw FileFinder scan did not become ready")
console.log(`wait for scan: ${(performance.now() - tw).toFixed(1)}ms`)

// warmup grep to let the content index build
const tWarmup = performance.now()
picker.grep("_warmup_", { mode: "regex", maxMatchesPerFile: 1, timeBudgetMs: 1_500 })
console.log(`grep warmup: ${(performance.now() - tWarmup).toFixed(1)}ms`)

console.log()
console.log("--- raw picker (warm) ---")

for (const q of FILE_QUERIES) {
  const t = performance.now()
  const r = picker.fileSearch(q, { pageSize: Math.max(FILE_LIMIT, 100) })
  const count = r.ok ? r.value.items.length : "err"
  console.log(`[picker] fileSearch "${q}": ${(performance.now() - t).toFixed(1)}ms (${count} results)`)
}

for (const q of GREP_QUERIES) {
  const t = performance.now()
  const r = picker.grep(q, { mode: "regex", pageSize: GREP_LIMIT, timeBudgetMs: 1_500 })
  const count = r.ok ? r.value.items.length : "err"
  console.log(`[picker] grep "${q}": ${(performance.now() - t).toFixed(1)}ms (${count} matches)`)
}

picker.destroy()

// --- Search service: init breakdown ---
try {
  console.log()

  // The V2 filesystem needs a Location-scoped Core graph, not the legacy runtime.
  const tRuntime = performance.now()
  await run(Effect.void)
  console.log(`[Search] init location runtime: ${(performance.now() - tRuntime).toFixed(1)}ms`)

  const tScan = performance.now()
  if ((await (await servicePicker.promise).waitForScan(2_500)) !== true)
    throw new Error("worker scan did not become ready")
  console.log(`[Search] init worker + scan: ${(performance.now() - tScan).toFixed(1)}ms`)

  // Core keeps mmap/content indexing disabled; this warms the first grep call.
  const tGrepWarmup = performance.now()
  await run(FileSystem.Service.use((svc) => svc.grep({ pattern: "_warmup_grep_", limit: 1 })))
  console.log(`[Search] first grep (warm scan): ${(performance.now() - tGrepWarmup).toFixed(1)}ms`)

  console.log()
  console.log("--- Search service (warm) ---")

  for (const q of FILE_QUERIES) {
    const t = performance.now()
    const r = await run(FileSystem.Service.use((svc) => svc.find({ query: q, limit: FILE_LIMIT })))
    console.log(`[Search.find] "${q}": ${(performance.now() - t).toFixed(1)}ms (${r.length} results)`)
  }

  for (const q of GREP_QUERIES) {
    const t = performance.now()
    const r = await run(FileSystem.Service.use((svc) => svc.grep({ pattern: q, limit: GREP_LIMIT })))
    console.log(`[Search.grep] "${q}": ${(performance.now() - t).toFixed(1)}ms (${r.length} matches)`)
  }

  for (const q of GLOB_QUERIES) {
    const t = performance.now()
    const r = await run(FileSystem.Service.use((svc) => svc.glob({ pattern: q, limit: GLOB_LIMIT })))
    console.log(`[Search.glob] "${q}": ${(performance.now() - t).toFixed(1)}ms (${r.length} files)`)
  }
} finally {
  await runtime.dispose()
}
console.log("[Search] disposed location runtime")

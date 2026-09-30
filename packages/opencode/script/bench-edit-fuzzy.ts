import leven from "leven"
import { replace } from "../src/tool/edit"
import { FuzzyBaseline } from "../test/tool/native-fuzzy-baseline"

// Run from packages/opencode: bun run script/bench-edit-fuzzy.ts
// Each backend/case gets a fresh process. Expected results are analytical, so
// the original matrix never contaminates the package's cold call or peak RSS.
const distances = [
  { name: "empty", a: "", b: "", expected: 0 },
  { name: "equal-512", a: "a".repeat(512), b: "a".repeat(512), expected: 0 },
  { name: "short", a: "kitten", b: "sitting", expected: 3 },
  ...[32, 128, 512, 1024].map((n) => ({ name: `dense-${n}`, a: "a".repeat(n), b: "b".repeat(n), expected: n })),
  { name: "scattered-512", a: "a".repeat(512), b: "aaab".repeat(128), expected: 128 },
  { name: "affix-512", a: "a".repeat(512), b: "a".repeat(255) + "b" + "a".repeat(256), expected: 1 },
  { name: "rectangular", a: "a".repeat(128), b: "b".repeat(512), expected: 512 },
  { name: "unicode", a: "😀\ud800".repeat(32), b: "😁\udc00".repeat(32), expected: 64 },
]
const replacements = [
  { name: "exact", content: "before\nexact\nafter", find: "exact", expected: "before\nnew\nafter" },
  ...[
    { name: "one-scattered-512", count: 1, middle: "aaab".repeat(128) },
    { name: "twelve-scattered-512", count: 12, middle: "aaab".repeat(128) },
    { name: "twelve-affix-512", count: 12, middle: "a".repeat(255) + "b" + "a".repeat(256) },
  ].map((fixture) => {
    const blocks = Array.from(
      { length: fixture.count },
      (_, i) => `start${" ".repeat(i)}\n${Array(4).fill(fixture.middle).join("\n")}\nend`,
    )
    return {
      name: fixture.name,
      content: blocks.join("\n"),
      find: `start\n${Array(4).fill("a".repeat(512)).join("\n")}\nend`,
      expected: ["new", ...blocks.slice(1)].join("\n"),
    }
  }),
]

const backend = process.argv[2]
const name = process.argv[3]
if (!backend) {
  for (const fixture of [...distances, ...replacements]) {
    for (const backend of ["original", "package"]) {
      const child = Bun.spawnSync([process.execPath, import.meta.path, backend, fixture.name], {
        cwd: process.cwd(),
        env: process.env,
        stdout: "pipe",
        stderr: "inherit",
      })
      if (child.exitCode !== 0) throw new Error(`Benchmark failed: ${backend}/${fixture.name}`)
      process.stdout.write(child.stdout)
    }
  }
  process.exit(0)
}
if (backend !== "original" && backend !== "package") throw new Error(`Unknown backend: ${backend}`)

const distance = distances.find((fixture) => fixture.name === name)
const replacement = replacements.find((fixture) => fixture.name === name)
if (!distance && !replacement) throw new Error(`Unknown case: ${name}`)
const calculate = backend === "original" ? FuzzyBaseline.levenshtein : leven
const edit = backend === "original" ? FuzzyBaseline.replace : replace
const run = distance
  ? () => calculate(distance.a, distance.b)
  : () => edit(replacement!.content, replacement!.find, "new")
const expected = distance ? distance.expected : replacement!.expected
const start = performance.now()
const cold = run()
const coldMs = performance.now() - start
if (cold !== expected) throw new Error(`Incorrect cold result: ${backend}/${name}`)

const batch = distance && distance.a.length < 40 && distance.b.length < 40 ? 100 : name === "exact" ? 100 : 1
for (let i = 0; i < 10; i++) run()
const samples = Array.from({ length: 31 }, () => {
  const start = performance.now()
  let result: string | number = ""
  for (let i = 0; i < batch; i++) result = run()
  const ms = (performance.now() - start) / batch
  if (result !== expected) throw new Error(`Incorrect warm result: ${backend}/${name}`)
  return ms
}).sort((a, b) => a - b)
console.log(
  JSON.stringify({
    name,
    backend,
    batch,
    coldMs,
    medianMs: samples[15],
    p95Ms: samples[29],
    peakRssKiB: process.resourceUsage().maxRSS,
  }),
)

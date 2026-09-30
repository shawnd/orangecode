import { test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { documentClient, stats } from "./documents-fixture"

test("actual stdio LSP document workload", async () => {
  await using tmp = await tmpdir()
  const output = []
  const text = "const value = 1234567890\n".repeat(4096)
  const files = Array.from({ length: 320 }, (_, i) => path.join(tmp.path, `${i}.ts`))
  await Promise.all(files.map((file) => Bun.write(file, text)))
  for (let trial = 0; trial < 4; trial++) {
    const client = await documentClient(tmp.path)
    try {
      const start = performance.now()
      await client.notify.open({ path: files[0]! })
      for (let i = 0; i < 200; i++) await client.notify.open({ path: files[0]! })
      const repeated = await stats(client)
      const repeatedMs = performance.now() - start
      const manyStart = performance.now()
      for (const file of files.slice(1)) await client.notify.open({ path: file })
      const many = await stats(client)
      const manyMs = performance.now() - manyStart
      const after = Date.now()
      const version = await client.notify.open({ path: files.at(-1)! })
      const waitStart = performance.now()
      await client.waitForDiagnostics({ path: files.at(-1)!, version, after, mode: "document" })
      output.push({
        trial,
        warmup: trial === 0,
        repeatedMs,
        manyMs,
        noopWaitMs: performance.now() - waitStart,
        repeated,
        many,
      })
    } finally {
      await client.shutdown()
    }
  }
  const result = {
    baseline: "e6f0f15a59125fb1775dd081da144ec16c4622aa",
    textBytes: Buffer.byteLength(text),
    repeats: 200,
    documents: files.length,
    trials: output,
  }
  console.log(JSON.stringify(result, null, 2))
  if (process.env.LSP_BENCH_OUTPUT)
    await Bun.write(process.env.LSP_BENCH_OUTPUT, JSON.stringify(result, null, 2) + "\n")
}, 120_000)

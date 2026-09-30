import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Fff } from "../src/filesystem/fff.bun"

// Run under the shared experiment flock. Fixtures live outside the worktree.
const root = process.env.PARALLEL_ARTIFACTS ?? "/tmp/opencode/server-parallel"
const fixture = path.join(root, "fixture")
const mode = process.argv[2] ?? "suite"
const stats = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  return {
    n: sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    max: sorted.at(-1) ?? 0,
  }
}
const options = { basePath: fixture, aiMode: true, disableMmapCache: true, disableContentIndexing: true }

if (mode === "prepare") {
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(fixture, { recursive: true })
  assert.equal(await Bun.spawn(["git", "init", "-q", fixture]).exited, 0)
  for (let batch = 0; batch < 4000; batch += 100) {
    await Promise.all(
      Array.from({ length: 100 }, (_, offset) => {
        const index = batch + offset
        return Bun.write(
          path.join(fixture, `src/group-${Math.floor(index / 100)}/component-${index}.ts`),
          `${index} é🙂 needle\n` + "export const value = 'representative source code';\n".repeat(320),
        )
      }),
    )
  }
  console.log(JSON.stringify({ fixture, files: 4000, seed: "parallel-v1", bytes: 4000 * 15700 }))
} else if (mode === "child") {
  const backend = process.argv[3]
  const pickers = Array.from({ length: backend === "worker2" ? 2 : 1 }, () =>
    backend === "direct"
      ? Fff.createDirect(options)
      : backend === "parallel"
        ? Fff.create(options)
        : Fff.createWorker(options),
  )
  const picker = pickers[0]
  if (!picker) throw new Error("benchmark has no picker")
  const lag: number[] = []
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    lag.push(Math.max(0, now - last - 2))
    last = now
  }, 2)
  const coldStart = performance.now()
  assert.ok((await Promise.all(pickers.map((picker) => picker.waitForScan(30_000)))).every(Boolean))
  const readyMs = performance.now() - coldStart
  const first = performance.now()
  assert.ok((await picker.fileSearch("component", { pageSize: 50 })).items.length)
  const firstMs = performance.now() - first
  const coldLag = stats(lag.splice(0))
  const query = async (index: number, signal?: AbortSignal) => {
    const picker = pickers[index % pickers.length]
    if (!picker) throw new Error("benchmark has no picker")
    if (index % 4 === 0) return picker.fileSearch("component", { pageSize: 50 }, signal)
    if (index % 4 === 1)
      return picker.grepMatches("needle", { mode: "regex", pageSize: 1000, timeBudgetMs: 1500 }, signal)
    return picker.grepMatches("absent_unique_token_123", { mode: "regex", pageSize: 50, timeBudgetMs: 1500 }, signal)
  }
  for (let index = 0; index < 8; index++) await query(index)
  lag.length = 0
  const completion: number[] = []
  const control: number[] = []
  const gate: number[] = []
  const controlTimer = setInterval(() => {
    const start = performance.now()
    setImmediate(() => control.push(performance.now() - start))
  }, 3)
  const cpu = process.cpuUsage()
  const start = performance.now()
  // Eight independent clients, each submits one request per turn. The model/tool
  // gate is deterministic timer traffic, not a claim about SessionRunner itself.
  await Promise.all(
    Array.from({ length: 8 }, async (_, client) => {
      for (let turn = 0; turn < 10; turn++) {
        const before = performance.now()
        await query(client + turn)
        completion.push(performance.now() - before)
        const released = performance.now()
        await Bun.sleep(2)
        gate.push(Math.max(0, performance.now() - released - 2))
      }
    }),
  )
  const elapsedMs = performance.now() - start
  const cpuUse = process.cpuUsage(cpu)
  const warmLag = stats(lag)
  clearInterval(controlTimer)
  // Cancellation includes the deadline's inability to run while native FFI
  // occupies the parent, as well as promise settlement after the abort.
  const cancellation: Array<{ deadlineMs: number; settleMs: number; outcome: string }> = []
  for (let round = 0; round < 6; round++) {
    const abort = new AbortController()
    const start = performance.now()
    let aborted = 0
    const cancel = setTimeout(() => {
      aborted = performance.now()
      abort.abort(new Error("obsolete query"))
    }, 2)
    const outcome = await query(2, abort.signal).then(
      () => "completed-before-abort",
      () => "aborted",
    )
    if (!aborted) await Bun.sleep(3)
    clearTimeout(cancel)
    cancellation.push({
      deadlineMs: aborted ? aborted - start : 0,
      settleMs: outcome === "aborted" ? performance.now() - aborted : 0,
      outcome,
    })
  }
  clearInterval(timer)
  console.log(
    JSON.stringify({
      mode: "mechanism",
      backend,
      bun: Bun.version,
      cpu: os.cpus()[0]?.model,
      readyMs,
      firstMs,
      coldLag,
      completionMs: stats(completion),
      warmLag,
      controlMs: stats(control),
      gateMs: stats(gate),
      elapsedMs,
      throughput: (completion.length * 1000) / elapsedMs,
      cpuMs: (cpuUse.user + cpuUse.system) / 1000,
      cancellation,
      evidence: picker.state,
    }),
  )
  await Promise.all(pickers.map((picker) => picker.destroy()))
  assert.equal(picker.state.destroyed, true)
  assert.equal(picker.state.started, false)
} else if (mode === "suite") {
  await fs.mkdir(root, { recursive: true })
  const rows: unknown[] = []
  for (let round = 0; round < 3; round++) {
    const arms = (process.env.PARALLEL_ARMS ?? "direct,worker").split(",")
    for (const backend of round % 2 ? arms.toReversed() : arms) {
      const child = Bun.spawn([process.execPath, import.meta.filename, "child", backend], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const samples: Array<{ pssKB: number; rssKB: number; threads: number }> = []
      const monitor = setInterval(async () => {
        const [smaps, status] = await Promise.all([
          Bun.file(`/proc/${child.pid}/smaps_rollup`)
            .text()
            .catch(() => ""),
          Bun.file(`/proc/${child.pid}/status`)
            .text()
            .catch(() => ""),
        ])
        if (!smaps) return
        samples.push({
          pssKB: Number(smaps.match(/^Pss:\s+(\d+)/m)?.[1]),
          rssKB: Number(smaps.match(/^Rss:\s+(\d+)/m)?.[1]),
          threads: Number(status.match(/^Threads:\s+(\d+)/m)?.[1]),
        })
      }, 20)
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      clearInterval(monitor)
      assert.equal(exit, 0, stderr)
      const row = {
        round,
        ...JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"),
        pssKB: stats(samples.map((sample) => sample.pssKB)),
        threads: stats(samples.map((sample) => sample.threads)),
        samples,
      }
      rows.push(row)
      console.log(JSON.stringify({ ...row, samples: undefined }))
    }
  }
  const output = path.join(root, `mechanism-${process.env.PARALLEL_LABEL ?? "baseline"}.json`)
  await Bun.write(output, JSON.stringify(rows, null, 2))
  console.log(output)
}

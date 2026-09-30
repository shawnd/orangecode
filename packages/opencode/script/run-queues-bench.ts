import path from "node:path"

// Run under the shared benchmark lock. Each sample gets a fresh process; paired
// arm order alternates and all arms execute the same frozen harness.
for (const repeat of [1, 2, 3]) {
  for (const mode of ["normal", "slow"]) {
    for (const kind of ["server", "client"]) {
      for (const arm of repeat % 2 ? ["base", "after"] : ["after", "base"]) {
        for (const bounded of kind === "server" && arm === "after" ? [false, true] : [false]) {
          const file =
            kind === "server"
              ? `/tmp/opencode/queues-paired-${arm}/bench-queues.js`
              : `/tmp/opencode/queues-client-${arm}/bench-queues-client.js`
          const result = Bun.spawnSync(["timeout", "30s", "bun", file, mode, ...(bounded ? ["--bounded"] : [])], {
            cwd: path.dirname(file),
          })
          if (result.exitCode !== 0) {
            throw new Error(`${kind}/${arm}/${mode}: ${result.exitCode}\n${result.stdout}\n${result.stderr}`)
          }
          const sample = result.stdout
            .toString()
            .split("\n")
            .findLast((line) => line.startsWith("{"))
          if (!sample) throw new Error(`Missing sample: ${result.stdout}`)
          console.log(JSON.stringify({ repeat, kind, arm, bounded, sample: JSON.parse(sample) }))
        }
      }
    }
  }
}

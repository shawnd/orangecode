import path from "node:path"

const directory = process.env.JOBS_RESULTS ?? "/tmp/opencode/server-jobs-parent-pairs"
const records = []
for (const repeat of [0, 1, 2]) {
  for (const arm of repeat % 2 === 0 ? ["baseline", "default", "changed"] : ["changed", "default", "baseline"]) {
    const output = path.join(directory, `r${repeat}-${arm}.json`)
    const child = Bun.spawn(
      [
        process.execPath,
        ...(arm === "baseline" ? ["--preload", "./script/jobs-baseline.ts"] : []),
        "./script/bench-server-jobs.ts",
      ],
      {
        env: {
          ...process.env,
          JOBS_ARM: arm,
          JOBS_OUTPUT: output,
          OPENCODE_EXPERIMENTAL_JOB_OUTPUT_RELEASE: arm === "default" ? "0" : "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    await Bun.write(path.join(directory, `r${repeat}-${arm}.log`), stdout + stderr)
    if (code !== 0) throw new Error(`${arm} repeat ${repeat} failed (${code}); inspect ${directory}`)
    const record = await Bun.file(output).json()
    records.push({ repeat, ...record })
    console.log(
      JSON.stringify({
        repeat,
        arm,
        idleTimerWakes: record.idleTimerWakes,
        listMs: record.listMs,
        shellListMs: record.shellListMs,
      }),
    )
  }
}
await Bun.write(path.join(directory, "samples.json"), JSON.stringify(records, null, 2))

const records = await Bun.file(process.argv[2] ?? "/tmp/opencode/server-jobs-parent-final/samples.json").json()
for (const arm of ["baseline", "default", "changed"]) {
  const samples = records.filter((sample: { arm: string }) => sample.arm === arm)
  const summary = Object.fromEntries(
    [
      "shortMs",
      "listMs",
      "shellListMs",
      "idleTimerWakes",
      "idleCpuUs",
      "idleWakeProxy",
      "burstMs",
      "cancelMs",
      "retainedPssKiB",
      "retainedGrowthKiB",
    ].map((metric) => {
      const values = samples
        .map((sample: { retained: { pssKiB: number }; before: { pssKiB: number }; [key: string]: unknown }) =>
          metric === "retainedPssKiB"
            ? sample.retained.pssKiB
            : metric === "retainedGrowthKiB"
              ? sample.retained.pssKiB - sample.before.pssKiB
              : Number(sample[metric]),
        )
        .toSorted((a: number, b: number) => a - b)
      return [metric, { median: values[Math.floor(values.length / 2)], min: values[0], max: values.at(-1), values }]
    }),
  )
  console.log(JSON.stringify({ arm, count: samples.length, summary }))
}

import path from "node:path"
import type { BunPlugin } from "bun"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

// Freeze both arms of the identical harness. Only production source modules are
// replaced, using git objects from the immutable baseline (never another branch).
const baseline = "8998bdb660d66c31a6e390c1195867b6c303c781"
const arm = process.argv[2]
const outdir = process.argv[3]
if ((arm !== "base" && arm !== "after") || !outdir)
  throw new Error("Usage: freeze-queues-bench.ts base|after OUTDIR [client]")
const client = process.argv[4] === "client"
const target = client
  ? "packages/tui/src/context/sdk.tsx"
  : "packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts"
const original = arm === "base" ? Bun.spawnSync(["git", "show", `${baseline}:${target}`]) : undefined
if (original && original.exitCode !== 0) throw new Error(original.stderr.toString())
const transform = client
  ? await import(
      path.join(path.dirname(Bun.resolveSync("@opentui/solid/bun-plugin", import.meta.dir)), "solid-transform.js")
    )
  : undefined
const result = await Bun.build({
  entrypoints: [client ? "script/bench-queues-client.tsx" : "script/bench-queues.ts"],
  target: "bun",
  define: {
    "process.platform": JSON.stringify(process.platform),
    "process.arch": JSON.stringify(process.arch),
    "process.env.OPENTUI_LIBC": JSON.stringify("glibc"),
  },
  outdir,
  plugins: [
    ...(arm === "base"
      ? [
          {
            name: "immutable-queues-baseline",
            setup(build: Parameters<BunPlugin["setup"]>[0]) {
              build.onLoad(
                { filter: client ? /\/context\/sdk\.tsx$/ : /\/httpapi\/handlers\/global\.ts$/ },
                async (args) => {
                  if (!args.path.endsWith(target.replace(/^packages\//, "")))
                    throw new Error(`Unexpected source override: ${args.path}`)
                  return {
                    contents: client
                      ? await transform?.transformSolidSource(original?.stdout.toString() ?? "", {
                          filename: args.path,
                          moduleName: "@opentui/solid",
                        })
                      : (original?.stdout
                          .toString()
                          .replace("function eventResponse()", "export function eventResponse()") ?? ""),
                    loader: client ? "js" : "ts",
                    resolveDir: path.dirname(args.path),
                  }
                },
              )
            },
          },
        ]
      : []),
    ...(client ? [createSolidTransformPlugin()] : []),
  ],
})
if (!result.success) throw new AggregateError(result.logs, "Queue benchmark build failed")
console.log(JSON.stringify({ arm, baseline, client, outputs: result.outputs.map((output) => output.path) }))

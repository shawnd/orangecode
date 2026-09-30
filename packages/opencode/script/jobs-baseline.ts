import { plugin } from "bun"
import { execFileSync } from "node:child_process"

// Load the actual frozen production sources, including their original imports.
const root = new URL("../../..", import.meta.url).pathname
const files = [
  "packages/core/src/background-job.ts",
  "packages/opencode/src/background/job.ts",
  "packages/opencode/src/background/shell.ts",
  "packages/opencode/src/tool/shell.ts",
]
const sources = new Map(
  files.map((file) => [
    root + file,
    execFileSync("git", ["show", `8998bdb660d66c31a6e390c1195867b6c303c781:${file}`], { cwd: root, encoding: "utf8" }),
  ]),
)
plugin({
  name: "frozen-jobs-production-sources",
  setup(build) {
    build.onLoad({ filter: /(?:background\/job|background\/shell|background-job|tool\/shell)\.ts$/ }, (args) => {
      const contents = sources.get(args.path)
      if (contents) return { contents, loader: "ts" }
    })
  },
})

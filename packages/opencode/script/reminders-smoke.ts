import { mkdtemp, mkdir, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { nativeArtifacts } from "./native-artifacts"

const directory = await mkdtemp(path.join(tmpdir(), "oc-reminders-compiled-"))
try {
  const result = await Bun.build({
    entrypoints: [path.resolve(import.meta.dirname, "../../core/test/native/reminders-smoke.ts")],
    plugins: [await nativeArtifacts({ os: "linux", arch: "x64" })],
    compile: { target: "bun-linux-x64", outfile: path.join(directory, "smoke") },
  })
  if (!result.success) throw new AggregateError(result.logs, "Could not compile reminder smoke executable")
  const empty = path.join(directory, "empty")
  await mkdir(empty)
  await rename(path.join(directory, "smoke"), path.join(empty, "smoke"))
  const child = Bun.spawn([path.join(empty, "smoke")], {
    cwd: empty,
    env: { HOME: empty, XDG_DATA_HOME: empty, XDG_STATE_HOME: empty, XDG_CACHE_HOME: empty },
    stdout: "inherit",
    stderr: "inherit",
  })
  if (await child.exited) throw new Error("Relocated embedded reminder smoke failed")
} finally {
  await rm(directory, { recursive: true, force: true })
}

import { $ } from "bun"
import path from "node:path"

export async function buildNative() {
  const directory = path.resolve(import.meta.dirname, "../native")
  await $`cargo build --release --locked`.cwd(directory)
  return path.join(
    directory,
    "target/release",
    process.platform === "darwin"
      ? "libopencode_native.dylib"
      : process.platform === "win32"
        ? "opencode_native.dll"
        : "libopencode_native.so",
  )
}

if (import.meta.main) console.log(await buildNative())

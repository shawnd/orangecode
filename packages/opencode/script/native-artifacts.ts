import type { BunPlugin } from "bun"
import path from "node:path"
import { buildNative } from "../../core/script/build-native"

// Enable only the target exercised by the real FFI and relocated compile tests.
// Other targets remain explicit unavailable descriptors rather than embedding a
// host library into an incompatible executable.
export async function nativeArtifacts(target: { os: string; arch: string; abi?: string }): Promise<BunPlugin> {
  const supported = target.os === "linux" && target.arch === "x64" && !target.abi
  const library = supported && process.platform === "linux" && process.arch === "x64" ? await buildNative() : undefined
  console.log(`native reminders: ${library ? "linux-x64 glibc" : "unavailable for this target"}`)
  return {
    name: "opencode-native-artifact",
    setup(build) {
      build.onLoad({ filter: /[/\\]core[/\\]src[/\\]native[/\\]artifact\.ts$/ }, () => ({
        contents: library
          ? `import file from ${JSON.stringify(library)} with { type: "file" }; export function nativeLibrary() { return file; }`
          : "export function nativeLibrary() { return undefined; }",
        loader: "ts",
        resolveDir: path.resolve(import.meta.dirname, "../../core/src/native"),
      }))
    },
  }
}

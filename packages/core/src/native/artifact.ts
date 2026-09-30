import path from "node:path"

// Build packaging replaces this exact module with a literal embedded file import.
// Source mode only probes this checkout, never another installed oc binary.
export function nativeLibrary() {
  if (process.platform !== "linux" || process.arch !== "x64") return
  const report = process.report.getReport()
  if (
    !("header" in report) ||
    typeof report.header !== "object" ||
    !report.header ||
    !("glibcVersionRuntime" in report.header)
  )
    return
  return path.resolve(import.meta.dirname, "../../native/target/release/libopencode_native.so")
}

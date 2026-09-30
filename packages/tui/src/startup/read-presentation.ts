import type { startupPresentation } from "./presentation"

// Serialized with the worker: no imported runtime bindings may be referenced.
export function readStartupPresentation(
  decode: typeof startupPresentation,
  env = process.env,
  directory?: string,
  filename?: string,
) {
  // A bounded regular-file read; O_NONBLOCK keeps an accidental FIFO from
  // holding the first input hostage. No config discovery or directory creation.
  const fs = process.getBuiltinModule("node:fs")
  let fd: number | undefined
  try {
    const home = process.getBuiltinModule("node:os").homedir()
    const state = env.XDG_STATE_HOME || `${home}/.local/state`
    fd = fs.openSync(
      filename ?? `${state}/opencode/startup-presentation.json`,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    )
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > 65536) return decode()
    const buffer = Buffer.alloc(65536)
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0)
    const value = decode(JSON.parse(buffer.toString("utf8", 0, size)))
    if (directory !== undefined && value.selection?.directory !== directory) value.selection = undefined
    if (directory !== undefined && value.slashes?.directory !== directory) value.slashes = undefined
    if (directory !== undefined && value.controls?.directory !== directory) value.controls = undefined
    return value
  } catch {
    return decode()
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

import type { ChildProcessWithoutNullStreams } from "child_process"
import { Process } from "@/util/process"
import { withTimeout } from "@/util/timeout"

type Child = Process.Child & ChildProcessWithoutNullStreams

export function spawn(cmd: string, args: string[], opts?: Process.Options): Child
export function spawn(cmd: string, opts?: Process.Options): Child
export function spawn(cmd: string, argsOrOpts?: string[] | Process.Options, opts?: Process.Options) {
  const args = Array.isArray(argsOrOpts) ? [...argsOrOpts] : []
  const cfg = Array.isArray(argsOrOpts) ? opts : argsOrOpts
  const proc = Process.spawn([cmd, ...args], {
    ...cfg,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as Child

  if (!proc.stdin || !proc.stdout || !proc.stderr) throw new Error("Process output not available")

  return proc
}

export async function stop(proc: ChildProcessWithoutNullStreams) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const exited = Promise.withResolvers<void>()
  const exit = () => exited.resolve()
  proc.once("exit", exit)
  try {
    await Process.stop(proc)
    await withTimeout(exited.promise, 1_000).catch(async () => {
      proc.kill("SIGKILL")
      await withTimeout(exited.promise, 1_000).catch(() => {})
    })
  } finally {
    proc.off("exit", exit)
  }
}

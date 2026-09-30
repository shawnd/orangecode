import type { Restart } from "@opencode-ai/tui/context/exit"

export function restartArgs(
  input: Restart,
  options?: {
    auto?: boolean
    attach?: { url: string; username?: string; password?: string }
    network?: { port: number; hostname: string; mdns: boolean; mdnsDomain: string; cors: string[] }
  },
) {
  return [
    ...(options?.attach
      ? [
          "attach",
          options.attach.url,
          ...(input.directory ? ["--dir", input.directory] : []),
          ...(options.attach.username !== undefined ? ["--username", options.attach.username] : []),
          ...(options.attach.password !== undefined ? ["--password", options.attach.password] : []),
        ]
      : input.directory
        ? [input.directory]
        : []),
    ...(input.sessionID ? ["--session", input.sessionID] : []),
    ...(options?.auto ? ["--auto"] : []),
    ...(options?.network
      ? [
          "--port",
          String(options.network.port),
          "--hostname",
          options.network.hostname,
          ...(options.network.mdns ? ["--mdns", "--mdns-domain", options.network.mdnsDomain] : []),
          ...options.network.cors.flatMap((origin) => ["--cors", origin]),
        ]
      : []),
  ]
}

export async function restartProcess(args: string[]) {
  // A compiled Bun executable has a virtual entrypoint; source launches need
  // their absolute entrypoint because the TUI may have changed directories.
  // Linux appends this suffix when deployment atomically replaces the running
  // executable. Restart from its installed path to load the replacement.
  const executable = process.execPath.replace(/ \(deleted\)$/, "")
  const command = [executable, ...(Bun.main.includes("$bunfs") ? [] : [Bun.main]), ...args]
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== "OPENCODE_ROUTE",
    ),
  )
  if (process.platform !== "win32" && process.execve) process.execve(command[0], command, env)
  const child = Bun.spawn(command, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  process.exitCode = await child.exited
}

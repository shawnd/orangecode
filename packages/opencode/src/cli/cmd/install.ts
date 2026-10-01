import os from "node:os"
import path from "node:path"
import { mkdir, realpath } from "node:fs/promises"
import { cmd } from "./cmd"

const start = "# >>> oc aliases >>>"
const end = "# <<< oc aliases <<<"

export const InstallCommand = cmd({
  command: "install",
  describe: "set up shell aliases when OpenCode is also installed",
  async handler() {
    const result = await installAliases()
    if (!result) {
      console.log("No separate OpenCode installation found; no aliases needed.")
      return
    }
    console.log(`Detected shell: ${result.shell}`)
    result.files.forEach((file) => console.log(`Shell aliases installed in ${file}`))
    console.log("opencode → oc; opencode-old → original OpenCode")
    console.log(
      `Restart your shell or run: ${["bash", "zsh", "fish"].includes(result.shell) ? "source" : "."} ${quote(result.files[0])}`,
    )
  },
})

export async function installAliases(input?: { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }) {
  const env = input?.env ?? process.env
  const original = Bun.which("opencode", { PATH: env.PATH ?? "" })
  if (!original) return
  const oc = Bun.which("oc", { PATH: env.PATH ?? "" })
  const resolved = await realpath(original)
  if (resolved === (await realpath(process.execPath)) || (oc && resolved === (await realpath(oc)))) return

  const home = input?.home ?? os.homedir()
  const platform = input?.platform ?? process.platform
  const shell = detectShell(env, env.SHELL ? null : os.userInfo().shell)
  const file = shellConfig(shell, home, env)
  const aliases =
    shell === "fish"
      ? "alias opencode 'oc'\nalias opencode-old 'command opencode'"
      : "alias opencode='oc'\nalias opencode-old='command opencode'"
  const block = `${start}\n${aliases}\n${end}`
  // macOS terminal windows normally use login shells. Bash reads the first
  // existing login profile instead of .bashrc; put aliases in both entrypoints.
  const profile = shell === "bash" && platform === "darwin" ? await bashProfile(home) : undefined
  const files = profile ? [file, profile] : [file]
  await Promise.all(files.map((file) => writeAliases(file, block)))
  return { files, shell }
}

export function detectShell(env: NodeJS.ProcessEnv, loginShell: string | null) {
  const executable = env.SHELL || loginShell
  if (!executable) {
    throw new Error("Could not detect your shell. Set SHELL to its executable path and rerun oc install.")
  }
  return path.basename(executable)
}

async function bashProfile(home: string) {
  const profiles = [".bash_profile", ".bash_login", ".profile"].map((name) => path.join(home, name))
  const existing = await Promise.all(profiles.map((profile) => Bun.file(profile).exists()))
  return profiles[existing.indexOf(true)] ?? profiles[0]
}

async function writeAliases(file: string, block: string) {
  const content = await readConfig(file)
  const output = updateBlock(content, block)
  if (output === content) return
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, output)
}

function shellConfig(shell: string, home: string, env: NodeJS.ProcessEnv) {
  if (shell === "bash") return path.join(home, ".bashrc")
  if (shell === "zsh") return path.join(env.ZDOTDIR || home, ".zshrc")
  if (shell === "fish") return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "fish", "config.fish")
  if (["sh", "ash", "dash", "ksh"].includes(shell)) return path.join(home, ".profile")
  throw new Error(
    `Unsupported shell: ${shell}. Add alias opencode='oc' and alias opencode-old='command opencode' to your shell config.`,
  )
}

async function readConfig(file: string) {
  return Bun.file(file)
    .text()
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })
}

function updateBlock(content: string, block: string) {
  const first = content.indexOf(start)
  if (first === -1) return `${content}${content.endsWith("\n") || !content ? "" : "\n"}\n${block}\n`
  const last = content.indexOf(end, first)
  if (last === -1) throw new Error("Incomplete oc aliases block; remove it and rerun oc install.")
  return content.slice(0, first) + block + content.slice(last + end.length)
}

function quote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

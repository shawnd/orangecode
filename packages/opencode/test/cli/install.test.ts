import { expect, test } from "bun:test"
import path from "node:path"
import { chmod, mkdir, symlink } from "node:fs/promises"
import { detectShell, installAliases } from "../../src/cli/cmd/install"
import { tmpdir } from "../fixture/fixture"

async function binaries(home: string) {
  await Promise.all(
    ["oc", "opencode"].map(async (name) => {
      const file = path.join(home, name)
      await Bun.write(file, `#!/bin/sh\nprintf '%s\\n' '${name}' "$@"\n`)
      await chmod(file, 0o755)
    }),
  )
  return { PATH: home, SHELL: "/bin/bash" }
}

async function run(args: string[], env: NodeJS.ProcessEnv) {
  const child = Bun.spawn(args, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

test.each([
  { shell: "/bin/zsh", loginShell: "/bin/bash", expected: "zsh" },
  { shell: "/usr/local/bin/fish", loginShell: "/bin/zsh", expected: "fish" },
  { shell: "/bin/bash", loginShell: "/bin/zsh", expected: "bash" },
  { shell: undefined, loginShell: "/bin/zsh", expected: "zsh" },
  { shell: "", loginShell: "/bin/bash", expected: "bash" },
])("detects $expected from the shell environment or account", ({ shell, loginShell, expected }) => {
  expect(detectShell({ SHELL: shell }, loginShell)).toBe(expected)
})

test("does not guess a shell when detection is unavailable", () => {
  expect(() => detectShell({}, null)).toThrow("Could not detect your shell")
})

test("does not touch shell config without a separate OpenCode installation", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, ".bashrc"), "# user config\n")
  expect(await installAliases({ home: tmp.path, env: { PATH: tmp.path, SHELL: "/bin/bash" } })).toBeUndefined()
  expect(await Bun.file(path.join(tmp.path, ".bashrc")).text()).toBe("# user config\n")
})

test("does not alias when opencode is a symlink to oc", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "oc"), "#!/bin/sh\n")
  await chmod(path.join(tmp.path, "oc"), 0o755)
  await symlink(path.join(tmp.path, "oc"), path.join(tmp.path, "opencode"))
  expect(await installAliases({ home: tmp.path, env: { PATH: tmp.path, SHELL: "/bin/bash" } })).toBeUndefined()
  expect(await Bun.file(path.join(tmp.path, ".bashrc")).exists()).toBe(false)
})

const shells = [
  { name: "bash", args: ["--noprofile", "--norc", "-O", "expand_aliases"] },
  { name: "zsh", args: ["-f"] },
  { name: "fish", args: ["--no-config"] },
]
shells.forEach((config) => {
  const shell = Bun.which(config.name)
  test.skipIf(!shell)(`${config.name} aliases execute both binaries and preserve arguments`, async () => {
    if (!shell) throw new Error(`Missing test shell: ${config.name}`)
    await using tmp = await tmpdir()
    const env = { ...(await binaries(tmp.path)), HOME: tmp.path, SHELL: shell }
    const result = await installAliases({ home: tmp.path, env, platform: "linux" })
    if (!result) throw new Error("Expected aliases to be installed")
    const script = path.join(tmp.path, "commands")
    await Bun.write(script, "opencode 'hello world' --version '*' ''\nopencode-old 'hello world' --version '*' ''\n")
    // Zsh parses a -c string before executing it. Load commands separately so
    // alias expansion happens after the rc file, as it does in a user's shell.
    const child = await run([shell, ...config.args, "-c", `source '${result.files[0]}'\nsource '${script}'`], env)
    expect(child).toEqual({
      code: 0,
      stdout: "oc\nhello world\n--version\n*\n\nopencode\nhello world\n--version\n*\n\n",
      stderr: "",
    })
  })
})

test("reinstall updates the managed block and preserves surrounding config", async () => {
  await using tmp = await tmpdir()
  const env = await binaries(tmp.path)
  const file = path.join(tmp.path, ".bashrc")
  await Bun.write(file, "# before\n# >>> oc aliases >>>\nalias opencode='old-value'\n# <<< oc aliases <<<\n# after\n")
  await installAliases({ home: tmp.path, env, platform: "linux" })
  const content = await Bun.file(file).text()
  await installAliases({ home: tmp.path, env, platform: "linux" })
  expect(await Bun.file(file).text()).toBe(content)
  expect(content).toStartWith("# before\n")
  expect(content).toEndWith("# after\n")
  expect(content).toContain("alias opencode='oc'")
  expect(content).not.toContain("old-value")
})

test("Zsh uses ZDOTDIR on macOS", async () => {
  await using tmp = await tmpdir()
  const env = { ...(await binaries(tmp.path)), SHELL: "/bin/zsh", ZDOTDIR: path.join(tmp.path, "zsh") }
  const result = await installAliases({ home: tmp.path, env, platform: "darwin" })
  expect(result?.files).toEqual([path.join(env.ZDOTDIR, ".zshrc")])
  expect(await Bun.file(path.join(env.ZDOTDIR, ".zshrc")).text()).toContain("alias opencode-old='command opencode'")
  expect(await Bun.file(path.join(tmp.path, ".bashrc")).exists()).toBe(false)
  expect(await Bun.file(path.join(tmp.path, ".bash_profile")).exists()).toBe(false)
})

test("macOS Zsh writes .zshrc in home when ZDOTDIR is unset", async () => {
  await using tmp = await tmpdir()
  const env = { ...(await binaries(tmp.path)), SHELL: "/bin/zsh" }
  expect(await installAliases({ home: tmp.path, env, platform: "darwin" })).toEqual({
    shell: "zsh",
    files: [path.join(tmp.path, ".zshrc")],
  })
  expect(await Bun.file(path.join(tmp.path, ".zshrc")).text()).toContain("alias opencode='oc'")
  expect(await Bun.file(path.join(tmp.path, ".bashrc")).exists()).toBe(false)
})

test("Fish uses XDG_CONFIG_HOME and Fish alias syntax", async () => {
  await using tmp = await tmpdir()
  const env = { ...(await binaries(tmp.path)), SHELL: "/usr/bin/fish", XDG_CONFIG_HOME: path.join(tmp.path, "config") }
  const result = await installAliases({ home: tmp.path, env })
  const file = path.join(env.XDG_CONFIG_HOME, "fish", "config.fish")
  expect(result?.files).toEqual([file])
  expect(await Bun.file(file).text()).toContain("alias opencode-old 'command opencode'")
})

test.each([
  { existing: [], selected: ".bash_profile" },
  { existing: [".profile"], selected: ".profile" },
  { existing: [".bash_login", ".profile"], selected: ".bash_login" },
  { existing: [".bash_profile", ".bash_login", ".profile"], selected: ".bash_profile" },
])("macOS Bash installs in the active login profile: $selected", async ({ existing, selected }) => {
  await using tmp = await tmpdir()
  const env = await binaries(tmp.path)
  await Promise.all(existing.map((name) => Bun.write(path.join(tmp.path, name), "# existing profile\n")))
  const profile = path.join(tmp.path, selected)
  expect(await installAliases({ home: tmp.path, env, platform: "darwin" })).toEqual({
    shell: "bash",
    files: [path.join(tmp.path, ".bashrc"), profile],
  })
  const content = await Bun.file(profile).text()
  await installAliases({ home: tmp.path, env, platform: "darwin" })
  expect(await Bun.file(profile).text()).toBe(content)
  expect(content).toContain("alias opencode='oc'")
  await Promise.all(
    existing
      .filter((name) => name !== selected)
      .map(async (name) => {
        expect(await Bun.file(path.join(tmp.path, name)).text()).toBe("# existing profile\n")
      }),
  )
  const child = await run(
    [
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-O",
      "expand_aliases",
      "-c",
      `source '${profile}'\nopencode --version\nopencode-old --version`,
    ],
    env,
  )
  expect(child).toEqual({ code: 0, stdout: "oc\n--version\nopencode\n--version\n", stderr: "" })
})

test("macOS Bash preserves an existing .bashrc source without adding another", async () => {
  await using tmp = await tmpdir()
  const env = await binaries(tmp.path)
  const file = path.join(tmp.path, ".bash_profile")
  const content = '# user setup\n[ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n'
  await Bun.write(file, content)
  await installAliases({ home: tmp.path, env, platform: "darwin" })
  const output = await Bun.file(file).text()
  expect(output).toStartWith(content)
  expect(output.split('. "$HOME/.bashrc"')).toHaveLength(2)
})

test("rejects an incomplete managed block without changing the file", async () => {
  await using tmp = await tmpdir()
  const env = await binaries(tmp.path)
  const file = path.join(tmp.path, ".bashrc")
  const content = "# user config\n# >>> oc aliases >>>\nalias opencode='custom'\n"
  await Bun.write(file, content)
  await expect(installAliases({ home: tmp.path, env, platform: "linux" })).rejects.toThrow(
    "Incomplete oc aliases block",
  )
  expect(await Bun.file(file).text()).toBe(content)
})

test("surfaces shell config read failures", async () => {
  await using tmp = await tmpdir()
  const env = await binaries(tmp.path)
  await mkdir(path.join(tmp.path, ".bashrc"))
  await expect(installAliases({ home: tmp.path, env, platform: "linux" })).rejects.toThrow()
})

test.each(["bash", "zsh"])("CLI install detects %s and updates only its config", async (shell) => {
  await using tmp = await tmpdir()
  const env = {
    ...process.env,
    ...(await binaries(tmp.path)),
    HOME: tmp.path,
    SHELL: `/bin/${shell}`,
    ZDOTDIR: tmp.path,
  }
  const result = await run([process.execPath, path.resolve(import.meta.dir, "../../src/cli/main.ts"), "install"], env)
  expect(result.code).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout).toContain(`Detected shell: ${shell}`)
  const file = path.join(tmp.path, shell === "zsh" ? ".zshrc" : ".bashrc")
  expect(await Bun.file(file).text()).toContain("alias opencode-old='command opencode'")
  const content = await Bun.file(file).text()
  expect(
    (await run([process.execPath, path.resolve(import.meta.dir, "../../src/cli/main.ts"), "install"], env)).code,
  ).toBe(0)
  expect(await Bun.file(file).text()).toBe(content)
})

test("CLI install exits successfully without a separate OpenCode executable", async () => {
  await using tmp = await tmpdir()
  const env = { ...process.env, HOME: tmp.path, SHELL: "/bin/zsh", PATH: tmp.path }
  const result = await run([process.execPath, path.resolve(import.meta.dir, "../../src/cli/main.ts"), "install"], env)
  expect(result).toEqual({
    code: 0,
    stdout: "No separate OpenCode installation found; no aliases needed.\n",
    stderr: "",
  })
  expect(await Bun.file(path.join(tmp.path, ".zshrc")).exists()).toBe(false)
})

test("CLI prints a working reload command for home paths containing spaces and quotes", async () => {
  await using tmp = await tmpdir()
  const env = {
    ...process.env,
    ...(await binaries(tmp.path)),
    HOME: path.join(tmp.path, "home with 'quotes'"),
    SHELL: "/bin/bash",
  }
  const result = await run([process.execPath, path.resolve(import.meta.dir, "../../src/cli/main.ts"), "install"], env)
  expect(result.code).toBe(0)
  const prefix = "Restart your shell or run: "
  const reload = result.stdout
    .split("\n")
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
  if (!reload) throw new Error("Expected a shell reload command")
  const child = await run(
    ["/bin/bash", "--noprofile", "--norc", "-O", "expand_aliases", "-c", `${reload}\nopencode --version`],
    env,
  )
  expect(child).toEqual({ code: 0, stdout: "oc\n--version\n", stderr: "" })
})

test("refuses an unsupported shell without writing a config", async () => {
  await using tmp = await tmpdir()
  const env = { ...(await binaries(tmp.path)), SHELL: "/bin/tcsh" }
  await expect(installAliases({ home: tmp.path, env })).rejects.toThrow("Unsupported shell: tcsh")
  expect(await Bun.file(path.join(tmp.path, ".bashrc")).exists()).toBe(false)
})

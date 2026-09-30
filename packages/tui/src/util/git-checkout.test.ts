import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { gitCheckout } from "./git-checkout"

test("identifies the main checkout and linked worktrees across branches and detached HEAD", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-git-status-"))
  const main = path.join(root, "main")
  const linked = path.join(root, "linked")
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }

  try {
    await mkdir(main)
    git("-C", main, "init", "--initial-branch=main")
    git(
      "-C",
      main,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    )
    git("-C", main, "worktree", "add", "-b", "feature", linked)

    expect(await gitCheckout(main)).toEqual({ branch: "main", linked: false })
    expect(await gitCheckout(linked)).toEqual({ branch: "feature", linked: true })
    expect(await gitCheckout(root)).toBeUndefined()
    expect(await gitCheckout(path.join(root, "missing"))).toBeUndefined()

    git("-C", linked, "checkout", "--detach")
    expect(await gitCheckout(linked)).toEqual({ branch: "detached", linked: true })
    expect(await gitCheckout(main)).toEqual({ branch: "main", linked: false })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

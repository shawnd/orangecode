export async function gitCheckout(directory: string) {
  if (!directory) return
  const process = Bun.spawn(
    [
      "git",
      "-C",
      directory,
      "rev-parse",
      "--is-inside-work-tree",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
      "--abbrev-ref",
      "HEAD",
    ],
    { stdout: "pipe", stderr: "ignore" },
  )
  const output = await new Response(process.stdout).text()
  if ((await process.exited) !== 0) return
  const [inside, gitDir, commonDir, branch] = output.trimEnd().split("\n")
  if (inside !== "true" || !gitDir || !commonDir || !branch) return
  return { branch: branch === "HEAD" ? "detached" : branch, linked: gitDir !== commonDir }
}

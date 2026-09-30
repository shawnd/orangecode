import { expect, test } from "bun:test"
import { chmod } from "node:fs/promises"
import { copyCommand } from "../src/clipboard"
import { tmpdir } from "./fixture/fixture"

test("prefers Wayland clipboard when available", () => {
  expect(copyCommand("linux", true, (name) => name === "wl-copy")).toEqual(["wl-copy"])
})

test("uses osascript on macOS", () => {
  expect(copyCommand("darwin", false, (name) => name === "osascript")).toEqual(["osascript"])
})

test("falls back through X11 clipboard commands", () => {
  expect(copyCommand("linux", true, (name) => name === "xclip")).toEqual(["xclip", "-selection", "clipboard"])
  expect(copyCommand("linux", false, (name) => name === "xsel")).toEqual(["xsel", "--clipboard", "--input"])
})

test("returns undefined when native clipboard is unavailable", () => {
  expect(copyCommand("linux", false, () => false)).toBeUndefined()
})

test.skipIf(process.platform !== "linux")("reads Wayland text without losing whitespace or using X11", async () => {
  expect(await readWayland({ text: "  clipboard\n日本語\t\n" })).toEqual({
    data: "  clipboard\n日本語\t\n",
    mime: "text/plain",
  })
})

test.skipIf(process.platform !== "linux")("prefers Wayland images over text", async () => {
  expect(await readWayland({ image: "wayland image", text: "clipboard text" })).toEqual({
    data: Buffer.from("wayland image").toString("base64"),
    mime: "image/png",
  })
})

test.skipIf(process.platform !== "linux")("falls back to X11 when Wayland text cannot be read", async () => {
  expect(await readWayland({})).toEqual({ data: Buffer.from("x11 image").toString("base64"), mime: "image/png" })
})

async function readWayland(content: { text?: string; image?: string }) {
  await using tmp = await tmpdir()
  // Isolate native commands in a subprocess; never touch the desktop clipboard or global environment.
  await Bun.write(
    `${tmp.path}/wl-paste`,
    `#!${process.execPath}
const args = process.argv.slice(2)
const content = ${JSON.stringify(content)}
if (args.join(" ") === "-t image/png" && content.image !== undefined) {
  process.stdout.write(content.image)
  process.exit(0)
}
if (args.join(" ") === "--no-newline --type text" && content.text !== undefined) {
  process.stdout.write(content.text)
  process.exit(0)
}
process.exit(1)
`,
  )
  await Bun.write(
    `${tmp.path}/xclip`,
    `#!${process.execPath}
process.stdout.write("x11 image")
`,
  )
  await chmod(`${tmp.path}/wl-paste`, 0o755)
  await chmod(`${tmp.path}/xclip`, 0o755)
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { read } = await import(${JSON.stringify(import.meta.resolve("../src/clipboard"))}); console.log(JSON.stringify(await read()))`,
    ],
    {
      env: { ...process.env, PATH: `${tmp.path}:${process.env.PATH}`, WAYLAND_DISPLAY: "test-wayland" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const output = await new Response(child.stdout).text()
  const error = await new Response(child.stderr).text()
  expect(await child.exited, error).toBe(0)
  return JSON.parse(output)
}

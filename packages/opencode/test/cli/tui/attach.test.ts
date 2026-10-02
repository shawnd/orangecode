import { describe, expect, test } from "bun:test"
import http from "node:http"

describe("tui attach", () => {
  test("remote session validation uses credentials inherited confidentially through env", async () => {
    const received: { authorization?: string; directory?: string; url?: string }[] = []
    const server = http.createServer((request, response) => {
      received.push({
        authorization: request.headers.authorization,
        directory: new URL(request.url ?? "/", "http://localhost").searchParams.get("directory") ?? undefined,
        url: request.url,
      })
      response.writeHead(request.headers.authorization === `Basic ${btoa("alice:secret:password")}` ? 200 : 401, {
        "content-type": "application/json",
      })
      response.end(JSON.stringify({ id: "ses_remote" }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("No HTTP address")
      const command = [
        process.execPath,
        "-e",
        `
        import { ServerAuth } from "./src/server/auth.ts"
        import { validateSession } from "./src/cli/tui/validate-session.ts"
        await validateSession({
          url: process.env.ATTACH_URL, sessionID: "ses_remote", directory: "/remote/project",
          headers: ServerAuth.headers(),
        })
        `,
      ]
      expect(command.join(" ")).not.toContain("secret:password")
      const child = Bun.spawn(command, {
        cwd: new URL("../../..", import.meta.url).pathname,
        env: {
          ...process.env,
          ATTACH_URL: `http://127.0.0.1:${address.port}`,
          OPENCODE_SERVER_USERNAME: "alice",
          OPENCODE_SERVER_PASSWORD: "secret:password",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const stderr = await new Response(child.stderr).text()
      expect(stderr).toBe("")
      expect(await child.exited).toBe(0)
      expect(received).toEqual([
        {
          authorization: `Basic ${btoa("alice:secret:password")}`,
          directory: "/remote/project",
          url: "/session/ses_remote?directory=%2Fremote%2Fproject",
        },
      ])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test("loads the TUI integration lazily", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/attach.ts", import.meta.url)).text()

    expect(source).toContain('await import("../tui/layer")')
    expect(source).toMatch(/await import\(["']@\/plugin\/tui\/runtime["']\)/)
    expect(source).not.toContain('import("./app")')
  })
})

/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { SidebarFooterView } from "../../../src/feature-plugins/sidebar/footer"
import { TuiPathsProvider } from "../../../src/context/runtime"

test("sidebar footer totals changes for the current session beside the path", async () => {
  const [files, setFiles] = createSignal([{ file: "a.ts", additions: 4, deletions: 3 }])
  const color = RGBA.fromHex("#ffffff")
  const api = {
    theme: {
      current: { text: color, textMuted: color, success: color, diffAdded: color, diffRemoved: color },
    },
    state: {
      provider: [],
      session: {
        get: () => ({ directory: "/home/test/my-app" }),
        diff: (sessionID: string) => (sessionID === "current" ? files() : [{ additions: 100, deletions: 100 }]),
      },
      path: { directory: "/home/test/my-app" },
      vcs: {},
    },
    kv: { get: () => true },
    app: { version: "test" },
  } as unknown as TuiPluginApi
  const app = await testRender(
    () => (
      <TuiPathsProvider value={{ cwd: "/home/test/my-app", home: "/home/test", state: "", worktree: "" }}>
        <box width={38}>
          <SidebarFooterView api={api} sessionID="current" />
        </box>
      </TuiPathsProvider>
    ),
    { width: 42, height: 4 },
  )

  try {
    await app.flush()
    expect(app.captureCharFrame()).toContain("~/my-app")
    expect(app.captureCharFrame()).toContain("+4 -3")

    setFiles([{ file: "b.ts", additions: 2, deletions: 0 }])
    await app.flush()
    expect(app.captureCharFrame()).toContain("+2")
    expect(app.captureCharFrame()).not.toContain("-3")
  } finally {
    app.renderer.destroy()
  }
})

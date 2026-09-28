/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { SidebarLspView } from "../../../src/feature-plugins/sidebar/lsp"

test("clicking the disabled LSP message enables LSPs and offers a disable toggle", async () => {
  const [enabled, setEnabled] = createSignal(false)
  const requests: boolean[] = []
  const color = RGBA.fromHex("#ffffff")
  const api = {
    theme: { current: { text: color, textMuted: color, success: color, error: color } },
    state: {
      get config() {
        return { lsp: enabled() }
      },
      path: { directory: "/project" },
      lsp: () => [],
    },
    client: {
      config: {
        update: async (input: { config: { lsp: boolean } }) => {
          requests.push(input.config.lsp)
          setEnabled(input.config.lsp)
          return { data: input.config }
        },
      },
    },
  } as unknown as TuiPluginApi
  const app = await testRender(() => <SidebarLspView api={api} />, { width: 75, height: 4 })

  try {
    await app.flush()
    expect(app.captureCharFrame()).toContain("LSPs are disabled (click to enable)")

    await app.mockMouse.click(5, 1)
    await app.flush()
    expect(requests).toEqual([true])
    expect(app.captureCharFrame()).toContain("click to disable")

    await app.mockMouse.click(5, 1)
    await app.flush()
    expect(requests).toEqual([true, false])
  } finally {
    app.renderer.destroy()
  }
})

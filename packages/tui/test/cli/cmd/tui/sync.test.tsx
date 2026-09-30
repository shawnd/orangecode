/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

describe("tui sync", () => {
  test("becomes ready with connected models before the full provider catalog and console", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const catalog = Promise.withResolvers<Response>()
    const consoleState = Promise.withResolvers<Response>()
    const connected = { id: "connected", name: "Connected", models: { chat: { id: "chat" } } }
    const disconnected = { id: "disconnected", name: "Disconnected", models: {} }
    const { app, sync } = await mount(
      (url) => {
        if (url.pathname === "/config/providers")
          return json({ providers: [connected], default: { connected: "chat" } })
        if (url.pathname === "/provider") return catalog.promise
        if (url.pathname === "/experimental/console") return consoleState.promise
        if (url.pathname === "/provider/auth") return json({ disconnected: [{ type: "api", label: "API key" }] })
      },
      tmp.path,
      "partial",
    )

    try {
      expect(sync.ready).toBe(true)
      expect(sync.status).toBe("partial")
      expect(sync.data.provider.map((provider) => provider.id)).toEqual(["connected"])
      expect(sync.data.provider[0].models.chat.id).toBe("chat")
      expect(sync.data.provider_next.all.map((provider) => provider.id)).toEqual(["connected"])
      expect(sync.data.provider_next.default.connected).toBe("chat")
      expect(sync.data.provider_next.connected).toEqual(["connected"])

      catalog.resolve(
        json({
          all: [connected, disconnected],
          default: { connected: "chat" },
          connected: ["connected", "disconnected"],
        }),
      )
      await wait(() => sync.data.provider_next.all.length === 2)
      expect(sync.status).toBe("partial")
      consoleState.resolve(json({ consoleManagedProviders: [], switchableOrgCount: 2 }))
      await wait(() => sync.status === "complete")
      expect(sync.data.provider_next.connected).toEqual(["connected", "disconnected"])
      expect(sync.data.provider_auth.disconnected).toEqual([{ type: "api", label: "API key" }])
      expect(sync.data.console_state.switchableOrgCount).toBe(2)
    } finally {
      catalog.resolve(json({ all: [], default: {}, connected: [] }))
      consoleState.resolve(json({ consoleManagedProviders: [], switchableOrgCount: 0 }))
      await app.dispose()
    }
  })

  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
    } finally {
      await app.dispose()
    }
  })

  test("explicit bootstrap awaits its catalog and an older catalog cannot overwrite a newer refresh", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const catalogs = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()]
    let requests = 0
    const { app, sync } = await mount((url) => {
      if (url.pathname !== "/provider") return
      const index = requests++ - 1
      if (index < 0) return json({ all: [], default: {}, connected: [] })
      return catalogs[index].promise
    }, tmp.path)
    try {
      let settled = false
      const older = sync.bootstrap({ fatal: false }).then(() => {
        settled = true
      })
      await wait(() => requests === 2)
      expect(settled).toBe(false)
      const newer = sync.bootstrap({ fatal: false })
      await wait(() => requests === 3)
      catalogs[1].resolve(json({ all: [], default: {}, connected: ["new"] }))
      await newer
      expect(sync.data.provider_next.connected).toEqual(["new"])
      catalogs[0].resolve(json({ all: [], default: {}, connected: ["old"] }))
      await older
      expect(settled).toBe(true)
      expect(sync.data.provider_next.connected).toEqual(["new"])
    } finally {
      for (const catalog of catalogs) catalog.resolve(json({ all: [], default: {}, connected: [] }))
      await app.dispose()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      await app.dispose()
    }
  })
})

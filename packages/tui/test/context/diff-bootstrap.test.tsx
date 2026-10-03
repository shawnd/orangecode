/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import type { Event } from "@opencode-ai/sdk/v2"
import { ArgsProvider, type Args } from "../../src/context/args"
import { DataProvider, useData } from "../../src/context/data"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { useRoute, type Route } from "../../src/context/route"
import { SDKProvider, useSDK } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, directory, json, type FetchHandler } from "../fixture/tui-sdk"
import { wait } from "../cli/cmd/tui/sync-fixture"

function diff(): Route {
  return { type: "plugin", id: "diff" }
}
const catalog = [
  "/api/location",
  "/api/agent",
  "/api/integration",
  "/api/model",
  "/api/provider",
  "/api/reference",
  "/api/command",
  "/api/skill",
]

async function mount(state: string, args: Args, override?: FetchHandler) {
  const requests: string[] = []
  const events = createEventSource()
  const calls = createFetch((url, request) => {
    requests.push(url.pathname)
    const response = override?.(url, request)
    if (response) return response
    if (["/permission", "/question"].includes(url.pathname)) return json([])
    if (["/api/permission/request", "/api/question/request"].includes(url.pathname)) return json({ data: [] })
  })
  const disposals = new Set<Promise<void>>()
  let context!: {
    sync: ReturnType<typeof useSync>
    data: ReturnType<typeof useData>
    route: ReturnType<typeof useRoute>
    sdk: ReturnType<typeof useSDK>
  }
  const mounted = Promise.withResolvers<void>()
  function Probe() {
    context = { sync: useSync(), data: useData(), route: useRoute(), sdk: useSDK() }
    onMount(() => mounted.resolve())
    return <box />
  }
  const app = await testRender(() => (
    <TestTuiContexts
      paths={{ state }}
      initialRoute={args.diff ? diff() : { type: "home" }}
      onDispose={(done) => disposals.add(done)}
    >
      <ArgsProvider {...args}>
        <KVProvider>
          <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
            <PermissionProvider>
              <ProjectProvider>
                <ExitProvider exit={() => {}}>
                  <SyncProvider>
                    <DataProvider>
                      <Probe />
                    </DataProvider>
                  </SyncProvider>
                </ExitProvider>
              </ProjectProvider>
            </PermissionProvider>
          </SDKProvider>
        </KVProvider>
      </ArgsProvider>
    </TestTuiContexts>
  ))
  await mounted.promise
  return {
    ...context,
    requests,
    count: (path: string) => requests.filter((item) => item === path).length,
    emit(payload: Event) {
      events.emit({ directory, project: "proj_test", payload })
      context.sdk.flushEvents()
    },
    async dispose() {
      app.renderer.destroy()
      await Promise.all(disposals)
    },
  }
}

describe("diff-first bootstrap admission", () => {
  test("bare diff hydrates only VCS, ignores unread invalidations, and resumes once on first close while loading", async () => {
    await using tmp = await tmpdir()
    const providers = Promise.withResolvers<Response>()
    const ctx = await mount(tmp.path, { diff: true }, (url) => {
      if (url.pathname === "/config/providers") return providers.promise
    })
    try {
      await wait(() => ctx.sync.data.vcs?.branch === "main")
      expect(ctx.requests).toEqual(["/vcs"])
      expect(ctx.sync.status).toBe("loading")
      expect(ctx.sync.ready).toBe(true)
      ctx.emit({ id: "evt_mcp", type: "mcp.tools.changed", properties: { server: "test" } })
      ctx.emit({ id: "evt_catalog", type: "catalog.updated", properties: {} })
      ctx.emit({ id: "evt_integration", type: "integration.updated", properties: {} })
      ctx.emit({ id: "evt_reference", type: "reference.updated", properties: {} })
      await Bun.sleep(30)
      expect(ctx.requests).toEqual(["/vcs"])

      ctx.emit({ id: "evt_vcs", type: "vcs.branch.updated", properties: { branch: "feature" } })
      expect(ctx.sync.data.vcs?.branch).toBe("feature")
      ctx.route.navigate({ type: "home" })
      await wait(() => ctx.count("/config/providers") === 1 && catalog.every((path) => ctx.count(path) === 1))
      expect(ctx.sync.status).toBe("loading")
      expect(ctx.sync.ready).toBe(true)
      ctx.route.navigate(diff())
      ctx.route.navigate({ type: "session", sessionID: "ses_test" })
      ctx.route.navigate(diff())
      providers.resolve(json({ providers: [], default: {} }))
      await wait(() => ctx.sync.status === "complete")
      expect(ctx.count("/config/providers")).toBe(1)
      expect(ctx.count("/session")).toBe(1)
      expect(catalog.map((path) => ctx.count(path))).toEqual(catalog.map(() => 1))
      // Once admitted, normal catalog invalidation stays live even after reopen.
      ctx.emit({ id: "evt_catalog_after", type: "catalog.updated", properties: {} })
      await wait(() => ctx.count("/api/model") === 2 && ctx.count("/api/provider") === 2)
    } finally {
      providers.resolve(json({ providers: [], default: {} }))
      await ctx.dispose()
    }
  })

  test.each([
    { diff: true, continue: true },
    { diff: true, sessionID: "ses_test" },
    { diff: true, fork: true, sessionID: "ses_test" },
    { diff: true, fork: true, continue: true },
  ])("keeps legacy session bootstrap for %j but defers V2 catalogs", async (args) => {
    await using tmp = await tmpdir()
    const ctx = await mount(tmp.path, args)
    try {
      await wait(() => ctx.sync.status === "complete")
      expect(ctx.count("/config/providers")).toBe(1)
      expect(ctx.count("/session")).toBe(1)
      expect(ctx.count("/session/status")).toBe(1)
      expect(catalog.map((path) => ctx.count(path))).toEqual(catalog.map(() => 0))
      ctx.route.navigate({ type: "plugin", id: "another-plugin" })
      await wait(() => catalog.every((path) => ctx.count(path) === 1))
      expect(ctx.count("/config/providers")).toBe(1)
    } finally {
      await ctx.dispose()
    }
  })

  test("ordinary home launches bootstrap both providers normally", async () => {
    await using tmp = await tmpdir()
    const ctx = await mount(tmp.path, {})
    try {
      await wait(() => ctx.sync.status === "complete" && catalog.every((path) => ctx.count(path) === 1))
      expect(ctx.count("/config/providers")).toBe(1)
      ctx.route.navigate(diff())
      ctx.route.navigate({ type: "home" })
      await Bun.sleep(30)
      expect(ctx.count("/config/providers")).toBe(1)
      expect(catalog.map((path) => ctx.count(path))).toEqual(catalog.map(() => 1))
    } finally {
      await ctx.dispose()
    }
  })

  test("instance disposal refresh stays minimal before admission and refreshes normally afterwards", async () => {
    await using tmp = await tmpdir()
    const ctx = await mount(tmp.path, { diff: true })
    try {
      await wait(() => ctx.count("/vcs") === 1)
      ctx.emit({ id: "evt_dispose", type: "server.instance.disposed", properties: { directory } })
      await wait(() => ctx.count("/vcs") === 2)
      expect(ctx.requests).toEqual(["/vcs", "/vcs"])
      expect(ctx.sync.status).toBe("loading")
      ctx.route.navigate({ type: "home" })
      await wait(() => ctx.sync.status === "complete")
      ctx.emit({ id: "evt_dispose_after", type: "server.instance.disposed", properties: { directory } })
      await wait(() => ctx.count("/config/providers") === 2)
    } finally {
      await ctx.dispose()
    }
  })

  test("recovery remains minimal before admission and restores normal snapshots after admission", async () => {
    await using tmp = await tmpdir()
    const ctx = await mount(tmp.path, { diff: true })
    try {
      await wait(() => ctx.sync.data.vcs?.branch === "main")
      ctx.emit({ id: "evt_connected", type: "server.connected", properties: {} })
      await ctx.sdk.eventsReady()
      expect(ctx.requests).toEqual(["/vcs", "/vcs"])
      expect(ctx.sync.status).toBe("loading")
      ctx.route.navigate({ type: "home" })
      await wait(() => ctx.sync.status === "complete")
      ctx.route.navigate(diff())
      ctx.emit({ id: "evt_reconnected", type: "server.connected", properties: {} })
      await ctx.sdk.eventsReady()
      expect(ctx.count("/permission")).toBe(1)
      expect(ctx.count("/question")).toBe(1)
      expect(ctx.count("/api/permission/request")).toBe(1)
      expect(ctx.count("/api/question/request")).toBe(1)
      expect(ctx.count("/config/providers")).toBe(1)
      expect(catalog.map((path) => ctx.count(path))).toEqual(catalog.map(() => 1))
    } finally {
      await ctx.dispose()
    }
  })

  test("an explicit in-flight resource refresh still receives invalidations while catalogs are deferred", async () => {
    await using tmp = await tmpdir()
    const integration = Promise.withResolvers<Response>()
    let reads = 0
    const ctx = await mount(tmp.path, { diff: true }, (url) => {
      if (url.pathname === "/api/integration" && ++reads === 1) return integration.promise
    })
    try {
      const refreshing = ctx.data.location.integration.refresh()
      await wait(() => reads === 1)
      ctx.emit({ id: "evt_integration_read", type: "integration.updated", properties: {} })
      integration.resolve(json({ location: { directory }, data: [{ id: "stale" }] }))
      await refreshing
      expect(reads).toBe(2)
      expect(ctx.data.location.integration.list()).toEqual([])
      expect(ctx.count("/api/model")).toBe(0)
      expect(ctx.count("/api/provider")).toBe(0)
      expect(ctx.count("/config/providers")).toBe(0)
    } finally {
      integration.resolve(json({ location: { directory }, data: [] }))
      await ctx.dispose()
    }
  })

  test("live branch metadata wins over a delayed minimal VCS snapshot", async () => {
    await using tmp = await tmpdir()
    const vcs = Promise.withResolvers<Response>()
    const ctx = await mount(tmp.path, { diff: true }, (url) => {
      if (url.pathname === "/vcs") return vcs.promise
    })
    try {
      await wait(() => ctx.count("/vcs") === 1)
      ctx.emit({ id: "evt_branch", type: "vcs.branch.updated", properties: { branch: "new" } })
      vcs.resolve(json({ branch: "old" }))
      await Bun.sleep(30)
      expect(ctx.sync.data.vcs?.branch).toBe("new")
      expect(ctx.sync.status).toBe("loading")
      expect(ctx.count("/config/providers")).toBe(0)
    } finally {
      vcs.resolve(json({ branch: "old" }))
      await ctx.dispose()
    }
  })
})

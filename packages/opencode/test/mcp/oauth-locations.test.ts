import { expect } from "bun:test"
import { createHash } from "node:crypto"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Context, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { MCP } from "../../src/mcp/index"
import { McpAuth } from "../../src/mcp/auth"
import { McpBrowser } from "../../src/mcp/browser"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import { InstanceStore } from "../../src/project/instance-store"
import { WorkspaceRef } from "../../src/effect/instance-ref"
import { tmpdirScoped, testInstanceStoreLayer } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const mcpLayer = LayerNode.compile(LayerNode.group([MCP.node, McpAuth.node, CrossSpawnSpawner.node]), [
  [McpBrowser.node, Layer.mock(McpBrowser.Service, { open: () => Effect.void })],
])
const it = testEffect(Layer.mergeAll(testInstanceStoreLayer, mcpLayer))

it.live("independent MCP Effect layers cannot borrow each other's same-directory flow", () =>
  Effect.gen(function* () {
    const ctx = yield* locations
    const a = yield* authority
    const b = yield* authority
    const first = Context.get(yield* Layer.build(Layer.fresh(mcpLayer)), MCP.Service)
    const second = Context.get(yield* Layer.build(Layer.fresh(mcpLayer)), MCP.Service)
    yield* ctx.inA(first.add(ctx.name, { type: "remote", url: a.url, enabled: false }))
    yield* ctx.inA(second.add(ctx.name, { type: "remote", url: b.url, enabled: false }))
    const flowA = yield* ctx.inA(first.startAuth(ctx.name))
    const flowB = yield* ctx.inA(second.startAuth(ctx.name))
    yield* ctx.inA(first.removeAuth(ctx.name))
    expect(Exit.isFailure(yield* ctx.inA(first.finishAuth(ctx.name, "foreign")).pipe(Effect.exit))).toBe(true)
    expect(yield* ctx.inA(second.finishAuth(ctx.name, b.code(flowB.authorizationUrl)))).toEqual({ status: "connected" })
    expect(a.exchanges).toHaveLength(0)
    expect(b.exchanges).toHaveLength(1)
    expect(flowA.oauthState).not.toBe(flowB.oauthState)
  }),
)

// Local OAuth authority actually checks code ownership, client and S256 PKCE.
// Each MCP reconnect gets a fresh SDK server transport (multiple Locations may
// deliberately share credentials for the same URL).
const authority = Effect.acquireRelease(
  Effect.promise(async () => {
    const exchanges: URLSearchParams[] = []
    const codes = new Map<string, { challenge: string; client: string }>()
    const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()
    const protocols: Server[] = []
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let hold = false
    let reconnectFails = false
    const http = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
          return Response.json({
            resource: `${url.origin}/mcp`,
            authorization_servers: [url.origin],
            scopes_supported: ["mcp"],
          })
        if (url.pathname === "/.well-known/oauth-authorization-server")
          return Response.json({
            issuer: url.origin,
            authorization_endpoint: `${url.origin}/authorize`,
            token_endpoint: `${url.origin}/token`,
            registration_endpoint: `${url.origin}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code"],
            token_endpoint_auth_methods_supported: ["none"],
            code_challenge_methods_supported: ["S256"],
            scopes_supported: ["mcp"],
          })
        if (url.pathname === "/register")
          return Response.json({ ...(await request.json()), client_id: crypto.randomUUID() }, { status: 201 })
        if (url.pathname === "/token") {
          const body = new URLSearchParams(await request.text())
          exchanges.push(body)
          if (hold) {
            entered.resolve()
            await release.promise
          }
          const code = codes.get(body.get("code") ?? "")
          if (
            !code ||
            code.client !== body.get("client_id") ||
            code.challenge !==
              createHash("sha256")
                .update(body.get("code_verifier") ?? "")
                .digest("base64url")
          )
            return Response.json({ error: "invalid_grant", error_description: "Foreign code or PKCE" }, { status: 400 })
          codes.delete(body.get("code") ?? "")
          return Response.json({ access_token: `${url.origin}-token`, token_type: "Bearer" })
        }
        if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 })
        if (request.headers.get("authorization") !== `Bearer ${url.origin}-token`)
          return new Response("Unauthorized", {
            status: 401,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp"`,
            },
          })
        if (reconnectFails) return new Response("Reconnect failed", { status: 503 })
        const id = request.headers.get("mcp-session-id")
        if (id) return sessions.get(id)?.handleRequest(request) ?? new Response("Unknown session", { status: 404 })
        if (request.method !== "POST") return new Response(null, { status: 405 })
        const protocol = new Server({ name: "location-oauth", version: "1" }, { capabilities: { tools: {} } })
        protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [] }))
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
        })
        protocols.push(protocol)
        await protocol.connect(transport)
        const response = await transport.handleRequest(request)
        if (transport.sessionId) sessions.set(transport.sessionId, transport)
        return response
      },
    })
    return {
      url: new URL("/mcp", http.url).href,
      exchanges,
      code(authorizationUrl: string) {
        const url = new URL(authorizationUrl)
        expect(url.origin).toBe(http.url.origin)
        expect(url.searchParams.get("state")).toHaveLength(64)
        expect(url.searchParams.get("code_challenge_method")).toBe("S256")
        const code = crypto.randomUUID()
        codes.set(code, {
          challenge: url.searchParams.get("code_challenge") ?? "",
          client: url.searchParams.get("client_id") ?? "",
        })
        return code
      },
      hold() {
        hold = true
      },
      failReconnect() {
        reconnectFails = true
      },
      entered: entered.promise,
      release: () => release.resolve(),
      close: async () => {
        release.resolve()
        await http.stop(true)
        await Promise.all(protocols.map((protocol) => protocol.close()))
      },
    }
  }),
  (server) => Effect.promise(server.close),
)

const locations = Effect.gen(function* () {
  const store = yield* InstanceStore.Service
  const mcp = yield* MCP.Service
  const auth = yield* McpAuth.Service
  const a = yield* tmpdirScoped()
  const b = yield* tmpdirScoped()
  yield* Effect.addFinalizer(() => Effect.promise(() => McpOAuthCallback.stop()))
  const name = `same-name-${crypto.randomUUID()}`
  yield* Effect.addFinalizer(() => auth.remove(name))
  const inA = <A, E, R>(effect: Effect.Effect<A, E, R>) => store.provide({ directory: a }, effect)
  const inB = <A, E, R>(effect: Effect.Effect<A, E, R>) => store.provide({ directory: b }, effect)
  const setup = (aURL: string, bURL: string) =>
    Effect.all(
      [
        inA(mcp.add(name, { type: "remote", url: aURL, enabled: false })),
        inB(mcp.add(name, { type: "remote", url: bURL, enabled: false })),
      ],
      { concurrency: "unbounded" },
    )
  return { store, mcp, auth, a, b, name, inA, inB, setup }
})

it.live("OAuth reconnect failure returns failed status and releases the pending flow", () =>
  Effect.gen(function* () {
    const ctx = yield* locations
    const server = yield* authority
    yield* ctx.inA(ctx.mcp.add(ctx.name, { type: "remote", url: server.url, enabled: false }))
    const flow = yield* ctx.inA(ctx.mcp.startAuth(ctx.name))
    server.failReconnect()
    const status = yield* ctx.inA(ctx.mcp.finishAuth(ctx.name, server.code(flow.authorizationUrl)))
    expect(status.status).toBe("failed")
    if (status.status !== "failed") throw new Error("Expected failed reconnect status")
    expect(status.error).toContain("OAuth reconnection failed")
    expect(server.exchanges).toHaveLength(1)
    expect(McpOAuthCallback.isRunning()).toBe(false)
    expect(Exit.isFailure(yield* ctx.inA(ctx.mcp.finishAuth(ctx.name, "replay")).pipe(Effect.exit))).toBe(true)
  }),
)

it.live("same-name Locations overlap start/finish with independent state, PKCE and transports", () =>
  Effect.gen(function* () {
    const ctx = yield* locations
    const a = yield* authority
    const b = yield* authority
    yield* ctx.setup(a.url, b.url)
    const [first, second] = yield* Effect.all(
      [ctx.inA(ctx.mcp.startAuth(ctx.name)), ctx.inB(ctx.mcp.startAuth(ctx.name))],
      { concurrency: "unbounded" },
    )
    expect(first.oauthState).not.toBe(second.oauthState)
    expect(new URL(first.authorizationUrl).searchParams.get("state")).toBe(first.oauthState)
    expect(new URL(second.authorizationUrl).searchParams.get("state")).toBe(second.oauthState)
    expect(new URL(first.authorizationUrl).searchParams.get("code_challenge")).not.toBe(
      new URL(second.authorizationUrl).searchParams.get("code_challenge"),
    )
    const entry = yield* ctx.auth.get(ctx.name)
    expect(entry?.oauthState).toBeUndefined()
    expect(entry?.codeVerifier).toBeUndefined()
    const statuses = yield* Effect.all(
      [
        ctx.inA(ctx.mcp.finishAuth(ctx.name, a.code(first.authorizationUrl))),
        ctx.inB(ctx.mcp.finishAuth(ctx.name, b.code(second.authorizationUrl))),
      ],
      { concurrency: "unbounded" },
    )
    expect(statuses).toEqual([{ status: "connected" }, { status: "connected" }])
    expect(a.exchanges).toHaveLength(1)
    expect(b.exchanges).toHaveLength(1)
    expect(Exit.isFailure(yield* ctx.inA(ctx.mcp.finishAuth(ctx.name, "replay")).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* ctx.inB(ctx.mcp.finishAuth(ctx.name, "replay")).pipe(Effect.exit))).toBe(true)
    expect(McpOAuthCallback.isRunning()).toBe(false)
  }),
)

it.live("concurrent same-Location auth restarts retire the old callback and complete only the newest flow", () =>
  Effect.gen(function* () {
    const ctx = yield* locations
    const server = yield* authority
    yield* ctx.inA(ctx.mcp.add(ctx.name, { type: "remote", url: server.url, enabled: false }))
    const [first, second] = yield* Effect.all(
      [ctx.inA(ctx.mcp.startAuth(ctx.name)), ctx.inA(ctx.mcp.startAuth(ctx.name))],
      { concurrency: "unbounded" },
    )
    expect(first.oauthState).not.toBe(second.oauthState)
    const stale = new URL(new URL(first.authorizationUrl).searchParams.get("redirect_uri") ?? "")
    stale.searchParams.set("state", first.oauthState)
    stale.searchParams.set("code", server.code(first.authorizationUrl))
    expect((yield* Effect.promise(() => fetch(stale))).status).toBe(400)
    expect(server.exchanges).toHaveLength(0)
    expect(yield* ctx.inA(ctx.mcp.finishAuth(ctx.name, server.code(second.authorizationUrl)))).toEqual({
      status: "connected",
    })
    expect(server.exchanges).toHaveLength(1)
    expect(McpOAuthCallback.isRunning()).toBe(false)
  }),
)

it.live("logout in one Location cannot cancel another same-name callback or remove foreign-URL credentials", () =>
  Effect.gen(function* () {
    const ctx = yield* locations
    const a = yield* authority
    const b = yield* authority
    yield* ctx.setup(a.url, b.url)
    const openedA = yield* Deferred.make<string>()
    const openedB = yield* Deferred.make<string>()
    const first = yield* ctx
      .inA(ctx.mcp.authenticate(ctx.name, (url) => Deferred.doneUnsafe(openedA, Effect.succeed(url))))
      .pipe(Effect.exit, Effect.forkScoped)
    const second = yield* ctx
      .inB(ctx.mcp.authenticate(ctx.name, (url) => Deferred.doneUnsafe(openedB, Effect.succeed(url))))
      .pipe(Effect.forkScoped)
    const urlA = new URL(yield* awaitWithTimeout(Deferred.await(openedA), "A did not start"))
    const urlB = new URL(yield* awaitWithTimeout(Deferred.await(openedB), "B did not start"))
    yield* ctx.inA(ctx.mcp.removeAuth(ctx.name))
    expect(Exit.isFailure(yield* Fiber.join(first))).toBe(true)
    const stale = yield* Effect.promise(() =>
      fetch(`${urlA.searchParams.get("redirect_uri")}?state=${urlA.searchParams.get("state")}&code=foreign`),
    )
    expect(stale.status).toBe(400)
    const redirect = new URL(urlB.searchParams.get("redirect_uri") ?? "")
    redirect.searchParams.set("state", urlB.searchParams.get("state") ?? "")
    redirect.searchParams.set("code", b.code(urlB.href))
    expect((yield* Effect.promise(() => fetch(redirect))).status).toBe(200)
    expect(yield* awaitWithTimeout(Fiber.join(second), "B did not finish")).toEqual({ status: "connected" })
    expect(a.exchanges).toHaveLength(0)
    expect(b.exchanges).toHaveLength(1)
    yield* ctx.inA(ctx.mcp.removeAuth(ctx.name))
    expect((yield* ctx.auth.getForUrl(ctx.name, b.url))?.tokens).toBeDefined()
    yield* ctx.inB(ctx.mcp.removeAuth(ctx.name))
    expect(yield* ctx.auth.get(ctx.name)).toBeUndefined()
  }),
)

it.live("interruption and Location disposal release only their own pending transports", () =>
  Effect.gen(function* () {
    const ctx = yield* locations
    const a = yield* authority
    const b = yield* authority
    yield* ctx.setup(a.url, b.url)
    const opened = yield* Deferred.make<string>()
    const first = yield* ctx
      .inA(ctx.mcp.authenticate(ctx.name, (url) => Deferred.doneUnsafe(opened, Effect.succeed(url))))
      .pipe(Effect.forkScoped)
    const second = yield* ctx.inB(ctx.mcp.startAuth(ctx.name))
    yield* awaitWithTimeout(Deferred.await(opened), "A did not start")
    yield* Fiber.interrupt(first)
    expect(Exit.isFailure(yield* ctx.inA(ctx.mcp.finishAuth(ctx.name, "foreign")).pipe(Effect.exit))).toBe(true)
    yield* ctx.inA(ctx.mcp.startAuth(ctx.name))
    yield* ctx.store.disposeDirectory(ctx.a)
    expect(yield* ctx.inB(ctx.mcp.finishAuth(ctx.name, b.code(second.authorizationUrl)))).toEqual({
      status: "connected",
    })
    expect(a.exchanges).toHaveLength(0)
    expect(b.exchanges).toHaveLength(1)
  }),
)

it.live("a foreign callback code cannot use another Location's transport and failed exchange cleans up", () =>
  Effect.gen(function* () {
    const ctx = yield* locations
    const a = yield* authority
    const b = yield* authority
    yield* ctx.setup(a.url, b.url)
    const first = yield* ctx.inA(ctx.mcp.startAuth(ctx.name))
    const opened = yield* Deferred.make<string>()
    const finishing = yield* ctx
      .inB(ctx.mcp.authenticate(ctx.name, (url) => Deferred.doneUnsafe(opened, Effect.succeed(url))))
      .pipe(Effect.forkScoped)
    const second = new URL(yield* awaitWithTimeout(Deferred.await(opened), "B did not start"))
    const foreign = a.code(first.authorizationUrl)
    const callback = new URL(second.searchParams.get("redirect_uri") ?? "")
    callback.searchParams.set("state", second.searchParams.get("state") ?? "")
    callback.searchParams.set("code", foreign)
    expect((yield* Effect.promise(() => fetch(callback))).status).toBe(200)
    expect((yield* awaitWithTimeout(Fiber.join(finishing), "B did not finish")).status).toBe("failed")
    expect(b.exchanges[0]?.get("code")).toBe(foreign)
    expect(a.exchanges).toHaveLength(0)
    expect(Exit.isFailure(yield* ctx.inB(ctx.mcp.finishAuth(ctx.name, b.code(second.href))).pipe(Effect.exit))).toBe(
      true,
    )
    expect(yield* ctx.inA(ctx.mcp.finishAuth(ctx.name, foreign))).toEqual({ status: "connected" })
  }),
)

it.live("explicit workspace identities partition pending flows even in the same directory", () =>
  Effect.gen(function* () {
    const ctx = yield* locations
    const server = yield* authority
    yield* ctx.setup(server.url, server.url)
    const firstWorkspace = WorkspaceV2.ID.make("wrk_oauth_first")
    const secondWorkspace = WorkspaceV2.ID.make("wrk_oauth_second")
    const first = yield* ctx.inA(ctx.mcp.startAuth(ctx.name)).pipe(Effect.provideService(WorkspaceRef, firstWorkspace))
    const second = yield* ctx
      .inA(ctx.mcp.startAuth(ctx.name))
      .pipe(Effect.provideService(WorkspaceRef, secondWorkspace))
    expect(first.oauthState).not.toBe(second.oauthState)
    yield* ctx.inA(ctx.mcp.removeAuth(ctx.name)).pipe(Effect.provideService(WorkspaceRef, firstWorkspace))
    expect(
      Exit.isFailure(
        yield* ctx
          .inA(ctx.mcp.finishAuth(ctx.name, server.code(first.authorizationUrl)))
          .pipe(Effect.provideService(WorkspaceRef, firstWorkspace), Effect.exit),
      ),
    ).toBe(true)
    expect(
      yield* ctx
        .inA(ctx.mcp.finishAuth(ctx.name, server.code(second.authorizationUrl)))
        .pipe(Effect.provideService(WorkspaceRef, secondWorkspace)),
    ).toEqual({ status: "connected" })
    expect(server.exchanges).toHaveLength(1)
  }),
)

it.live("logout during token exchange prevents a late token commit without cancelling the other Location", () =>
  Effect.gen(function* () {
    const ctx = yield* locations
    const a = yield* authority
    const b = yield* authority
    yield* ctx.setup(a.url, b.url)
    const first = yield* ctx.inA(ctx.mcp.startAuth(ctx.name))
    const second = yield* ctx.inB(ctx.mcp.startAuth(ctx.name))
    a.hold()
    const finishing = yield* ctx
      .inA(ctx.mcp.finishAuth(ctx.name, a.code(first.authorizationUrl)))
      .pipe(Effect.exit, Effect.forkScoped)
    yield* awaitWithTimeout(
      Effect.promise(() => a.entered),
      "Token exchange did not start",
    )
    yield* ctx.inA(ctx.mcp.removeAuth(ctx.name))
    a.release()
    expect(Exit.isFailure(yield* Fiber.join(finishing))).toBe(true)
    expect(yield* ctx.auth.getForUrl(ctx.name, a.url)).toBeUndefined()
    expect(yield* ctx.inB(ctx.mcp.finishAuth(ctx.name, b.code(second.authorizationUrl)))).toEqual({
      status: "connected",
    })
  }),
)

it.live("same-URL credentials remain user-shared and legacy auth files remain readable", () =>
  Effect.gen(function* () {
    const ctx = yield* locations
    const server = yield* authority
    yield* ctx.setup(server.url, server.url)
    yield* ctx.auth.set(ctx.name, {
      tokens: { accessToken: `${new URL(server.url).origin}-token` },
      oauthState: "old-state",
      codeVerifier: "old-verifier",
      serverUrl: server.url,
    })
    yield* ctx.inA(ctx.mcp.connect(ctx.name))
    yield* ctx.inB(ctx.mcp.connect(ctx.name))
    expect((yield* ctx.inA(ctx.mcp.status()))[ctx.name]).toEqual({ status: "connected" })
    expect((yield* ctx.inB(ctx.mcp.status()))[ctx.name]).toEqual({ status: "connected" })
    expect(server.exchanges).toHaveLength(0)
    const orphan = `orphan-${crypto.randomUUID()}`
    yield* ctx.auth.set(orphan, { tokens: { accessToken: "legacy-orphan-token" } })
    yield* ctx.inA(ctx.mcp.removeAuth(orphan))
    expect(yield* ctx.auth.get(orphan)).toBeUndefined()
  }),
)

it.live("provider callback rejection retires only the matching flow, including explicit startAuth flows", () =>
  Effect.gen(function* () {
    const ctx = yield* locations
    const a = yield* authority
    const b = yield* authority
    yield* ctx.setup(a.url, b.url)
    const first = yield* ctx.inA(ctx.mcp.startAuth(ctx.name))
    const second = yield* ctx.inB(ctx.mcp.startAuth(ctx.name))
    const callback = new URL(new URL(first.authorizationUrl).searchParams.get("redirect_uri") ?? "")
    callback.searchParams.set("state", first.oauthState)
    callback.searchParams.set("error", "access_denied")
    expect((yield* Effect.promise(() => fetch(callback))).status).toBe(200)
    expect(
      Exit.isFailure(yield* ctx.inA(ctx.mcp.finishAuth(ctx.name, a.code(first.authorizationUrl))).pipe(Effect.exit)),
    ).toBe(true)
    expect(yield* ctx.inB(ctx.mcp.finishAuth(ctx.name, b.code(second.authorizationUrl)))).toEqual({
      status: "connected",
    })
    expect(a.exchanges).toHaveLength(0)
    expect(b.exchanges).toHaveLength(1)
  }),
)

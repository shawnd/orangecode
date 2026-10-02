import { createConnection } from "net"
import { createServer } from "http"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { OAUTH_CALLBACK_PORT, parseRedirectUri } from "./oauth-provider"

interface PendingAuth {
  resolve: (code: string) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  endpoint: { port: number; path: string }
}

const servers = new Map<number, ReturnType<typeof createServer>>()
const starting = new Map<number, Promise<void>>()
const pendingAuths = new Map<string, PendingAuth>()
// Compatibility for callers that register immediately after ensureRunning().
// MCP passes its own redirect URI explicitly and cancels by random flow state.
let currentEndpoint = parseRedirectUri()
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

function take(state: string) {
  const pending = pendingAuths.get(state)
  if (!pending) return
  clearTimeout(pending.timeout)
  pendingAuths.delete(state)
  return pending
}

function stopIfIdle(port: number) {
  if (Array.from(pendingAuths.values()).some((pending) => pending.endpoint.port === port)) return
  servers.get(port)?.close()
  servers.delete(port)
}

function handleRequest(port: number, req: import("http").IncomingMessage, res: import("http").ServerResponse) {
  const url = new URL(req.url || "/", `http://localhost:${port}`)
  const state = url.searchParams.get("state")
  const pending = state ? pendingAuths.get(state) : undefined
  const paths = Array.from(pendingAuths.values()).filter((entry) => entry.endpoint.port === port)
  if (
    !paths.some((entry) => entry.endpoint.path === url.pathname) &&
    !(currentEndpoint.port === port && currentEndpoint.path === url.pathname)
  ) {
    res.writeHead(404)
    res.end("Not found")
    return
  }
  const error = url.searchParams.get("error")
  const code = url.searchParams.get("code")
  const valid = pending && pending.endpoint.port === port && pending.endpoint.path === url.pathname
  if (!state || !valid) {
    const message = !state
      ? "Missing required state parameter - potential CSRF attack"
      : "Invalid or expired state parameter - potential CSRF attack"
    // Unknown provider errors are still rendered, but never settle a flow.
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
    res.end(
      OauthCallbackPage.error(error ? url.searchParams.get("error_description") || error : message, { provider: "MCP" }),
    )
    return
  }
  if (!error && !code) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
    res.end(OauthCallbackPage.error("No authorization code provided", { provider: "MCP" }))
    return
  }
  const entry = take(state)
  if (error) entry?.reject(new Error(url.searchParams.get("error_description") || error))
  if (code && !error) entry?.resolve(code)
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(
    error
      ? OauthCallbackPage.error(url.searchParams.get("error_description") || error, { provider: "MCP" })
      : OauthCallbackPage.success({ provider: "MCP" }),
  )
  stopIfIdle(port)
}

export async function ensureRunning(redirectUri?: string, oauthState?: string): Promise<void> {
  const endpoint = parseRedirectUri(redirectUri)
  currentEndpoint = endpoint
  if (servers.has(endpoint.port)) return
  const existing = starting.get(endpoint.port)
  if (existing) {
    await existing
    if (oauthState && !pendingAuths.has(oauthState)) stopIfIdle(endpoint.port)
    return
  }
  const start = (async () => {
    if (await isPortInUse(endpoint.port)) return
    const server = createServer((req, res) => handleRequest(endpoint.port, req, res))
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(endpoint.port, "127.0.0.1", resolve)
    })
    servers.set(endpoint.port, server)
  })()
  starting.set(endpoint.port, start)
  await start.finally(() => starting.delete(endpoint.port))
  if (oauthState && !pendingAuths.has(oauthState)) stopIfIdle(endpoint.port)
}

export function waitForCallback(oauthState: string, redirectUri?: string): Promise<string> {
  if (pendingAuths.has(oauthState)) throw new Error("OAuth state already registered")
  const endpoint = redirectUri ? parseRedirectUri(redirectUri) : currentEndpoint
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      take(oauthState)?.reject(new Error("OAuth callback timeout - authorization took too long"))
      stopIfIdle(endpoint.port)
    }, CALLBACK_TIMEOUT_MS)
    pendingAuths.set(oauthState, { resolve, reject, timeout, endpoint })
  })
}

export function cancelPending(oauthState: string): void {
  const pending = take(oauthState)
  if (!pending) return
  pending.reject(new Error("Authorization cancelled"))
  stopIfIdle(pending.endpoint.port)
}

export async function isPortInUse(port: number = OAUTH_CALLBACK_PORT): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, "127.0.0.1")
    socket.on("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.on("error", () => resolve(false))
  })
}

export async function stop(): Promise<void> {
  await Promise.all(starting.values())
  for (const [state] of pendingAuths) take(state)?.reject(new Error("OAuth callback server stopped"))
  await Promise.all(
    Array.from(servers.values(), (server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  servers.clear()
}

export function isRunning(): boolean {
  return servers.size > 0
}

export * as McpOAuthCallback from "./oauth-callback"

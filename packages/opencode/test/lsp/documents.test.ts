import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { LSPClient } from "@/lsp/client"
import { tmpdir } from "../fixture/fixture"
import { documentClient, stats } from "./documents-fixture"

async function withDocuments(fn: (client: LSPClient.Info, directory: string) => Promise<void>) {
  await using tmp = await tmpdir()
  const client = await documentClient(tmp.path)
  try {
    await fn(client, tmp.path)
  } finally {
    await client.shutdown()
  }
}

async function fill(client: LSPClient.Info, directory: string, count = 70, text = "x") {
  for (let i = 0; i < count; i++) {
    const file = path.join(directory, `${i}.ts`)
    await Bun.write(file, text)
    await client.notify.open({ path: file })
  }
}

test("unchanged concurrent touches keep versions and unversioned diagnostics fresh", () =>
  withDocuments(async (client, directory) => {
    const file = path.join(directory, "a.ts")
    await Bun.write(file, "first\r\n🙂")
    const versions = await Promise.all(Array.from({ length: 20 }, () => client.notify.open({ path: file })))
    expect(new Set(versions).size).toBe(1)
    await stats(client)
    const after = Date.now()
    const version = await client.notify.open({ path: file })
    const started = performance.now()
    await Promise.all(
      Array.from({ length: 3 }, () => client.waitForDiagnostics({ path: file, version, after, mode: "document" })),
    )
    expect(performance.now() - started).toBeLessThan(1000)
    expect(client.diagnostics.get(file)?.[0]?.message).toBe("fixture diagnostic")
    await Bun.write(file, "second")
    expect(await client.notify.open({ path: file })).toBe(version + 1)
    expect(await client.notify.open({ path: file })).toBe(version + 1)
    const events = await client.connection.sendRequest<{ method: string; end?: unknown }[]>("test/events")
    expect(events.find((x) => x.method === "didChange")?.end).toEqual({ line: 1, character: 2 })
    expect(await stats(client)).toMatchObject({ didOpen: 1, didChange: 1, didClose: 0, watched: 2, violations: [] })
  }))

test("count LRU evicts with didClose, touches refresh recency, queries reopen", () =>
  withDocuments(async (client, directory) => {
    await fill(client, directory, 64)
    const file = path.join(directory, "0.ts")
    await client.notify.open({ path: file })
    const next = path.join(directory, "next.ts")
    await Bun.write(next, "next")
    await client.notify.open({ path: next })
    expect(await stats(client)).toMatchObject({ didOpen: 65, didClose: 1, openDocuments: 64, violations: [] })
    const events = await client.connection.sendRequest<{ method: string; uri: string }[]>("test/events")
    expect(events.find((x) => x.method === "didClose")?.uri).toBe(pathToFileURL(path.join(directory, "1.ts")).href)
    const hover = await client.connection.sendRequest("textDocument/hover", {
      textDocument: { uri: pathToFileURL(path.join(directory, "1.ts")).href },
    })
    expect(hover).toEqual({ open: true, text: "x" })
    expect(await stats(client)).toMatchObject({ didOpen: 66, didClose: 2, violations: [] })
  }))

test("a concurrent edit supersedes an outstanding diagnostic wait", () =>
  withDocuments(async (client, directory) => {
    await client.connection.sendRequest("test/configure", { publish: false, versioned: true })
    const file = path.join(directory, "edit.ts")
    await Bun.write(file, "before")
    const version = await client.notify.open({ path: file })
    const waiting = client.waitForDiagnostics({ path: file, version, mode: "document" })
    await Bun.write(file, "after")
    await client.connection.sendRequest("test/configure", { publish: true })
    await client.notify.open({ path: file })
    const started = performance.now()
    await waiting
    expect(performance.now() - started).toBeLessThan(1000)
    expect(client.diagnostics.get(file)?.[0]?.message).toBe("fixture diagnostic")
  }))

test(
  "a server that never publishes is waited for once per version, then dynamic pulls still work",
  () =>
    withDocuments(async (client, directory) => {
      await client.connection.sendRequest("test/configure", { publish: false })
      const file = path.join(directory, "silent.ts")
      await Bun.write(file, "silent")
      const version = await client.notify.open({ path: file })
      await client.waitForDiagnostics({ path: file, version, mode: "document" })
      const started = performance.now()
      expect(await client.notify.open({ path: file })).toBe(version)
      await client.waitForDiagnostics({ path: file, version, after: Date.now(), mode: "document" })
      expect(performance.now() - started).toBeLessThan(1000)
      await client.connection.sendRequest("test/register")
      await client.waitForDiagnostics({ path: file, version, mode: "document" })
      expect(client.diagnostics.get(file)?.[0]?.message).toBe("fixture diagnostic")
    }),
  10_000,
)

test("byte budget and oversized files close after use rather than staying resident", () =>
  withDocuments(async (client, directory) => {
    await fill(client, directory, 12, "x".repeat(512 * 1024))
    const bounded = await stats(client)
    expect(bounded.openDocuments).toBeLessThanOrEqual(8)
    expect(bounded.retainedTextBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    const file = path.join(directory, "large.ts")
    await Bun.write(file, "y".repeat(5 * 1024 * 1024))
    const version = await client.notify.open({ path: file })
    await client.waitForDiagnostics({ path: file, version, mode: "document" })
    expect(client.diagnostics.get(file)?.[0]?.message).toBe("fixture diagnostic")
    expect(await stats(client)).toMatchObject({ openDocuments: 0, retainedTextBytes: 0, violations: [] })
    const reopened = await client.notify.open({ path: file })
    expect(reopened).toBeGreaterThan(version)
    await client.waitForDiagnostics({ path: file, version: reopened, mode: "document" })
    expect(client.diagnostics.get(file)?.[0]?.message).toBe("fixture diagnostic")
  }))

test("in-flight raw RPC pins documents through eviction pressure", () =>
  withDocuments(async (client, directory) => {
    const file = path.join(directory, "query.ts")
    await Bun.write(file, "query")
    await client.notify.open({ path: file })
    await client.connection.sendRequest("test/configure", { hold: true })
    const hover = client.connection.sendRequest("textDocument/hover", {
      textDocument: { uri: pathToFileURL(file).href },
    })
    await fill(client, directory)
    expect((await stats(client)).openDocuments).toBeLessThanOrEqual(64)
    await client.connection.sendRequest("test/release")
    expect(await hover).toEqual({ open: true, text: "query" })
    expect((await stats(client)).openDocuments).toBeLessThanOrEqual(64)
  }))

test("diagnostic waits pin documents and dynamic registration still unblocks them", () =>
  withDocuments(async (client, directory) => {
    await client.connection.sendRequest("test/configure", { publish: false })
    const file = path.join(directory, "waiting.ts")
    await Bun.write(file, "waiting")
    const version = await client.notify.open({ path: file })
    const waiting = client.waitForDiagnostics({ path: file, version, mode: "document" })
    await fill(client, directory)
    const events = await client.connection.sendRequest<{ method: string; uri: string }[]>("test/events")
    expect(events.some((x) => x.method === "didClose" && x.uri === pathToFileURL(file).href)).toBe(false)
    await client.connection.sendRequest("test/register")
    await waiting
    expect(client.diagnostics.get(file)?.[0]?.message).toBe("fixture diagnostic")
    expect((await stats(client)).openDocuments).toBeLessThanOrEqual(64)
  }))

test("reopen uses a new version and ignores a previous lifetime's versioned push", () =>
  withDocuments(async (client, directory) => {
    const file = path.join(directory, "old.ts")
    await Bun.write(file, "old")
    const version = await client.notify.open({ path: file })
    await fill(client, directory)
    await stats(client)
    const reopened = await client.notify.open({ path: file })
    expect(reopened).toBeGreaterThan(version)
    await client.waitForDiagnostics({ path: file, version: reopened, mode: "document" })
    await client.connection.sendRequest("test/publish", { uri: pathToFileURL(file).href, version, diagnostics: [] })
    expect(client.diagnostics.get(file)?.[0]?.message).toBe("fixture diagnostic")
    expect((await stats(client)).violations).toEqual([])
  }))

test("slow identifier pulls keep documents pinned after an early matching result", () =>
  withDocuments(async (client, directory) => {
    await client.connection.sendRequest("test/configure", { publish: false, holdIdentifier: "slow" })
    await client.connection.sendRequest("test/register", { identifiers: ["fast", "slow"] })
    const file = path.join(directory, "pull.ts")
    await Bun.write(file, "pull")
    const version = await client.notify.open({ path: file })
    await client.waitForDiagnostics({ path: file, version, mode: "document" })
    expect(await client.connection.sendRequest<number>("test/pending")).toBe(1)
    await fill(client, directory)
    expect((await stats(client)).openDocuments).toBeLessThanOrEqual(64)
    const events = await client.connection.sendRequest<{ method: string; uri: string }[]>("test/events")
    expect(events.some((event) => event.method === "didClose" && event.uri === pathToFileURL(file).href)).toBe(false)
    await client.connection.sendRequest("test/release")
    expect((await stats(client)).openDocuments).toBeLessThanOrEqual(64)
  }))

test("shutdown cancels outstanding waits and rejects queued/new opens", () =>
  withDocuments(async (client, directory) => {
    await client.connection.sendRequest("test/configure", { publish: false })
    const file = path.join(directory, "stop.ts")
    await Bun.write(file, "stop")
    const version = await client.notify.open({ path: file })
    const waiting = client.waitForDiagnostics({ path: file, version, mode: "document" })
    const opening = client.notify.open({ path: file }).catch((error: Error) => error.message)
    const closed = Promise.withResolvers<unknown>()
    client.connection.onNotification("test/shutdown", closed.resolve)
    const started = performance.now()
    await client.shutdown()
    expect(await closed.promise).toMatchObject({ didClose: 1, openDocuments: 0 })
    await waiting
    expect(await opening).toBe("LSP client is shutting down")
    expect(performance.now() - started).toBeLessThan(1000)
    expect(client.diagnostics.size).toBe(0)
    await expect(client.notify.open({ path: file })).rejects.toThrow("shutting down")
  }))

test("a pull response for a superseded edit is discarded and retried", () =>
  withDocuments(async (client, directory) => {
    await client.connection.sendRequest("test/configure", { publish: false, hold: true, snapshotDiagnostics: true })
    await client.connection.sendRequest("test/register")
    const file = path.join(directory, "snapshot.ts")
    await Bun.write(file, "before")
    const version = await client.notify.open({ path: file })
    const started = Promise.withResolvers<void>()
    client.connection.onNotification("test/pull-started", () => started.resolve())
    const waiting = client.waitForDiagnostics({ path: file, version, mode: "document" })
    await started.promise
    await Bun.write(file, "after")
    await client.notify.open({ path: file })
    await client.connection.sendRequest("test/configure", { hold: false })
    await client.connection.sendRequest("test/release")
    await waiting
    expect(client.diagnostics.get(file)?.[0]?.message).toBe("after")
  }))

test("completed diagnostics have a bounded text-free handoff and reset on reopen", () =>
  withDocuments(async (client, directory) => {
    await client.connection.sendRequest("test/configure", { publish: false })
    await client.connection.sendRequest("test/register")
    for (let i = 0; i < 144; i++) {
      const file = path.join(directory, `${i}.ts`)
      await Bun.write(file, "x")
      const version = await client.notify.open({ path: file })
      await client.waitForDiagnostics({ path: file, version, mode: "document" })
    }
    expect(await stats(client)).toMatchObject({ openDocuments: 64, retainedTextBytes: 64 })
    const oldest = path.join(directory, "0.ts")
    const recent = path.join(directory, "79.ts")
    expect(client.diagnosticsFor(oldest) ?? []).toEqual([])
    expect(client.hasDiagnosticErrors(oldest)).toBe(false)
    expect(client.diagnosticsFor(recent)?.[0]?.message).toBe("fixture diagnostic")
    expect(client.hasDiagnosticErrors(recent)).toBe(true)
    expect([...client.diagnosticFiles()]).toContain(recent)
    expect(client.diagnostics.get(recent)?.[0]?.message).toBe("fixture diagnostic")
    await client.notify.open({ path: recent })
    expect(client.diagnosticsFor(recent)).toBeUndefined()
    await client.shutdown()
    expect(client.diagnostics.size).toBe(0)
    expect([...client.diagnosticFiles()]).toEqual([])
  }))

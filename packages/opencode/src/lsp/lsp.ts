import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import * as LSPClient from "./client"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import * as LSPServer from "./server"
import { Config } from "@/config/config"
import { spawn, stop } from "./launch"
import { Effect, Layer, Context, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { containsPath } from "@/project/instance-context"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LspEvent } from "@opencode-ai/schema/lsp-event"
import { withTimeout } from "@/util/timeout"

export const Event = LspEvent

const Position = Schema.Struct({
  line: NonNegativeInt,
  character: NonNegativeInt,
})

export const Range = Schema.Struct({
  start: Position,
  end: Position,
}).annotate({ identifier: "Range" })
export type Range = typeof Range.Type

export const Symbol = Schema.Struct({
  name: Schema.String,
  kind: NonNegativeInt,
  location: Schema.Struct({
    uri: Schema.String,
    range: Range,
  }),
}).annotate({ identifier: "Symbol" })
export type Symbol = typeof Symbol.Type

export const DocumentSymbol = Schema.Struct({
  name: Schema.String,
  detail: Schema.optional(Schema.String),
  kind: NonNegativeInt,
  range: Range,
  selectionRange: Range,
}).annotate({ identifier: "DocumentSymbol" })
export type DocumentSymbol = typeof DocumentSymbol.Type

export const Status = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
  status: Schema.Literals(["connected", "error"]),
}).annotate({ identifier: "LSPStatus" })
export type Status = typeof Status.Type

enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

const kinds = [
  SymbolKind.Class,
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Interface,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Struct,
  SymbolKind.Enum,
]

const filterExperimentalServers = (servers: Record<string, LSPServer.Info>, flags: RuntimeFlags.Info) => {
  if (flags.experimentalLspTy) {
    if (servers["pyright"]) {
      delete servers["pyright"]
    }
  } else {
    if (servers["ty"]) {
      delete servers["ty"]
    }
  }
}

type LocInput = { file: string; line: number; character: number }

// Installations share a destination per server, even across project roots.
// Serialize each server's spawn/install phase while starting different servers
// concurrently. Never share a process handle between clients.
const installations = new Map<string, Promise<void>>()

interface State {
  clients: LSPClient.Info[]
  servers: Record<string, LSPServer.Info>
  broken: Map<string, number>
  spawning: Map<string, Promise<LSPClient.Info | undefined>>
  disposed: boolean
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly status: () => Effect.Effect<Status[]>
  readonly hasClients: (file: string) => Effect.Effect<boolean>
  readonly touchFile: (input: string, diagnostics?: "document" | "full") => Effect.Effect<void>
  readonly diagnostics: (input?: {
    files: readonly string[]
    otherFiles?: number
  }) => Effect.Effect<Record<string, LSPClient.Diagnostic[]>>
  readonly hover: (input: LocInput) => Effect.Effect<any>
  readonly definition: (input: LocInput) => Effect.Effect<any[]>
  readonly references: (input: LocInput) => Effect.Effect<any[]>
  readonly implementation: (input: LocInput) => Effect.Effect<any[]>
  readonly documentSymbol: (uri: string) => Effect.Effect<(DocumentSymbol | Symbol)[]>
  readonly workspaceSymbol: (query: string) => Effect.Effect<Symbol[]>
  readonly prepareCallHierarchy: (input: LocInput) => Effect.Effect<any[]>
  readonly incomingCalls: (input: LocInput) => Effect.Effect<any[]>
  readonly outgoingCalls: (input: LocInput) => Effect.Effect<any[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LSP") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("LSP.state")(function* (ctx) {
        const cfg = yield* config.get()

        const servers: Record<string, LSPServer.Info> = {}

        if (!cfg.lsp) {
          yield* Effect.logInfo("all LSPs are disabled")
        } else {
          for (const server of Object.values(LSPServer)) {
            servers[server.id] = server
          }

          filterExperimentalServers(servers, flags)

          if (cfg.lsp !== true) {
            for (const [name, item] of Object.entries(cfg.lsp)) {
              const existing = servers[name]
              if (item.disabled) {
                yield* Effect.logInfo(`LSP server ${name} is disabled`)
                delete servers[name]
                continue
              }
              servers[name] = {
                ...existing,
                id: name,
                root: existing?.root ?? (async (_file, ctx) => ctx.directory),
                extensions: item.extensions ?? existing?.extensions ?? [],
                spawn: async (root) => ({
                  process: spawn(item.command[0], item.command.slice(1), {
                    cwd: root,
                    env: { ...process.env, ...item.env },
                  }),
                  initialization: item.initialization,
                }),
              }
            }
          }

          yield* Effect.logInfo("enabled LSP servers", {
            serverIds: Object.values(servers)
              .map((server) => server.id)
              .join(", "),
          })
        }

        const s: State = {
          clients: [],
          servers,
          broken: new Map(),
          spawning: new Map(),
          disposed: false,
        }

        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            s.disposed = true
            await Promise.all(s.clients.map((client) => client.shutdown()))
          }),
        )

        return s
      }),
    )

    const getClients = Effect.fnUntraced(function* (file: string) {
      const ctx = yield* InstanceState.context
      if (!containsPath(file, ctx)) return [] as LSPClient.Info[]
      const s = yield* InstanceState.get(state)
      const extension = path.parse(file).ext || path.basename(file)
      s.clients = s.clients.filter((client) => client.connected)
      if (s.disposed) return []
      async function schedule(server: LSPServer.Info, root: string, key: string) {
        let expired = false
        const installation = (installations.get(server.id) ?? Promise.resolve()).then(() => {
          if (expired || s.disposed) return
          return server.spawn(root, ctx, flags)
        })
        const released = installation.then(
          () => {},
          () => {},
        )
        installations.set(server.id, released)
        void released.then(() => {
          if (installations.get(server.id) === released) installations.delete(server.id)
        })
        const handle = await withTimeout(
          installation.then(async (handle) => {
            if (!handle) return
            if (expired || s.disposed) {
              await stop(handle.process)
              return
            }
            return handle
          }),
          120_000,
        )
          .then((value) => {
            if (!value) s.broken.set(key, Date.now())
            return value
          })
          .catch((error) => {
            expired = true
            s.broken.set(key, Date.now())
            Effect.runSync(Effect.logError("LSP startup failed", { serverID: server.id, root, error }))
            return undefined
          })

        if (!handle) return undefined
        const client = await LSPClient.create({
          serverID: server.id,
          server: handle,
          root,
          directory: ctx.directory,
          instance: ctx,
        }).catch(async (error) => {
          s.broken.set(key, Date.now())
          Effect.runSync(Effect.logError("LSP initialization failed", { serverID: server.id, root, error }))
          await stop(handle.process)
          return undefined
        })

        if (!client) return undefined
        if (s.disposed) {
          await client.shutdown()
          return undefined
        }

        const existing = s.clients.find((x) => x.root === root && x.serverID === server.id)
        if (existing) {
          await client.shutdown()
          return existing
        }

        s.clients.push(client)
        return client
      }

      const clients = yield* Effect.forEach(
        Object.values(s.servers).filter((server) => !server.extensions.length || server.extensions.includes(extension)),
        (server) =>
          Effect.promise(async () => {
            const root = await server.root(file, ctx).catch(() => undefined)
            if (!root || s.disposed) return
            const key = JSON.stringify([root, server.id])
            const failed = s.broken.get(key)
            if (failed !== undefined && Date.now() - failed < 60_000) return
            s.broken.delete(key)
            const match = s.clients.find((x) => x.root === root && x.serverID === server.id)
            if (match?.connected) return { client: match, updated: false }
            const inflight = s.spawning.get(key)
            if (inflight) return { client: await inflight, updated: false }
            const task = schedule(server, root, key)
            s.spawning.set(key, task)
            const client = await task.finally(() => {
              if (s.spawning.get(key) === task) s.spawning.delete(key)
            })
            return { client, updated: Boolean(client) }
          }),
        { concurrency: 4 },
      )
      if (clients.some((result) => result?.updated)) yield* events.publish(Event.Updated, {})
      return clients.flatMap((result) => (result?.client ? [result.client] : []))
    })

    const run = Effect.fnUntraced(function* <T>(
      file: string,
      fn: (client: LSPClient.Info, signal: AbortSignal) => Promise<T>,
    ) {
      const clients = yield* getClients(file)
      return yield* Effect.promise((signal) => Promise.all(clients.map((x) => fn(x, signal))))
    })

    const runAll = Effect.fnUntraced(function* <T>(fn: (client: LSPClient.Info, signal: AbortSignal) => Promise<T>) {
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise((signal) =>
        Promise.all(s.clients.filter((client) => client.connected).map((x) => fn(x, signal))),
      )
    })

    const init = Effect.fn("LSP.init")(function* () {
      yield* InstanceState.get(state)
    })

    const status = Effect.fn("LSP.status")(function* () {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      const result: Status[] = []
      for (const client of s.clients) {
        result.push({
          id: client.serverID,
          name: s.servers[client.serverID].id,
          root: path.relative(ctx.directory, client.root),
          status: client.connected ? "connected" : "error",
        })
      }
      return result
    })

    const hasClients = Effect.fn("LSP.hasClients")(function* (file: string) {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(async () => {
        if (!containsPath(file, ctx)) return false
        const extension = path.parse(file).ext || path.basename(file)
        for (const server of Object.values(s.servers)) {
          if (server.extensions.length && !server.extensions.includes(extension)) continue
          const root = await server.root(file, ctx)
          if (!root) continue
          const failed = s.broken.get(JSON.stringify([root, server.id]))
          if (failed !== undefined && Date.now() - failed < 60_000) continue
          return true
        }
        return false
      })
    })

    const touchFile = Effect.fn("LSP.touchFile")(function* (input: string, diagnostics?: "document" | "full") {
      yield* Effect.logInfo("touching file", { file: input })
      const clients = yield* getClients(input)
      yield* Effect.promise(() =>
        Promise.all(
          clients.map(async (client) => {
            const after = Date.now()
            const version = await client.notify.open({ path: input })
            if (!diagnostics) return
            return client.waitForDiagnostics({
              path: input,
              version,
              mode: diagnostics,
              after,
            })
          }),
        ).catch(() => {}),
      )
    })

    const diagnostics = Effect.fn("LSP.diagnostics")(function* (input?: {
      files: readonly string[]
      otherFiles?: number
    }) {
      const results: Record<string, LSPClient.Diagnostic[]> = {}
      if (input) {
        const ctx = yield* InstanceState.context
        const s = yield* InstanceState.get(state)
        const requested = new Set(input.files.map((file) => FSUtil.normalizePath(path.resolve(ctx.directory, file))))
        const selected = (input.otherFiles ?? 0) > 0 ? new Set<string>() : requested
        if (input.otherFiles && input.otherFiles > 0) {
          // Preserve first-seen file order across clients, including files whose
          // first client has warnings but a later client has errors. Only merge
          // selected files, and stop once the bounded context is complete.
          let remaining = input.otherFiles
          for (const client of s.clients) {
            for (const file of client.diagnosticFiles()) {
              if (selected.has(file)) continue
              const current = requested.has(file)
              if (!current && remaining <= 0) continue
              if (!current && !s.clients.some((client) => client.hasDiagnosticErrors(file))) continue
              selected.add(file)
              requested.delete(file)
              if (!current) remaining--
              if (remaining === 0 && requested.size === 0) break
            }
            if (remaining === 0 && requested.size === 0) break
          }
        }
        for (const file of selected) {
          for (const client of s.clients) {
            const issues = client.diagnosticsFor(file)
            if (!issues) continue
            const arr = results[file] ?? []
            arr.push(...issues)
            results[file] = arr
          }
        }
        return results
      }
      const all = yield* runAll(async (client) => client.diagnostics)
      for (const result of all) {
        for (const [p, diags] of result.entries()) {
          const arr = results[p] || []
          arr.push(...diags)
          results[p] = arr
        }
      }
      return results
    })

    const hover = Effect.fn("LSP.hover")(function* (input: LocInput) {
      return yield* run(input.file, (client, signal) =>
        client
          .request(
            "textDocument/hover",
            {
              textDocument: { uri: pathToFileURL(input.file).href },
              position: { line: input.line, character: input.character },
            },
            signal,
          )
          .catch(() => null),
      )
    })

    const definition = Effect.fn("LSP.definition")(function* (input: LocInput) {
      const results = yield* run(input.file, (client, signal) =>
        client
          .request(
            "textDocument/definition",
            {
              textDocument: { uri: pathToFileURL(input.file).href },
              position: { line: input.line, character: input.character },
            },
            signal,
          )
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const references = Effect.fn("LSP.references")(function* (input: LocInput) {
      const results = yield* run(input.file, (client, signal) =>
        client
          .request(
            "textDocument/references",
            {
              textDocument: { uri: pathToFileURL(input.file).href },
              position: { line: input.line, character: input.character },
              context: { includeDeclaration: true },
            },
            signal,
          )
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const implementation = Effect.fn("LSP.implementation")(function* (input: LocInput) {
      const results = yield* run(input.file, (client, signal) =>
        client
          .request(
            "textDocument/implementation",
            {
              textDocument: { uri: pathToFileURL(input.file).href },
              position: { line: input.line, character: input.character },
            },
            signal,
          )
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const documentSymbol = Effect.fn("LSP.documentSymbol")(function* (uri: string) {
      const file = fileURLToPath(uri)
      const results = yield* run(file, (client, signal) =>
        client.request("textDocument/documentSymbol", { textDocument: { uri } }, signal).catch(() => []),
      )
      return (results.flat() as (DocumentSymbol | Symbol)[]).filter(Boolean)
    })

    const workspaceSymbol = Effect.fn("LSP.workspaceSymbol")(function* (query: string) {
      const results = yield* runAll((client, signal) =>
        client
          .request<Symbol[] | null>("workspace/symbol", { query }, signal)
          .then((result) => (result ?? []).filter((x) => kinds.includes(x.kind)).slice(0, 10))
          .catch(() => [] as Symbol[]),
      )
      return results.flat()
    })

    const prepareCallHierarchy = Effect.fn("LSP.prepareCallHierarchy")(function* (input: LocInput) {
      const results = yield* run(input.file, (client, signal) =>
        client
          .request(
            "textDocument/prepareCallHierarchy",
            {
              textDocument: { uri: pathToFileURL(input.file).href },
              position: { line: input.line, character: input.character },
            },
            signal,
          )
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const callHierarchyRequest = Effect.fnUntraced(function* (
      input: LocInput,
      direction: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls",
    ) {
      const results = yield* run(input.file, async (client, signal) => {
        const items = await client
          .request<unknown[] | null>(
            "textDocument/prepareCallHierarchy",
            {
              textDocument: { uri: pathToFileURL(input.file).href },
              position: { line: input.line, character: input.character },
            },
            signal,
          )
          .catch(() => [] as unknown[])
        if (!items?.length) return []
        return client.request(direction, { item: items[0] }, signal).catch(() => [])
      })
      return results.flat().filter(Boolean)
    })

    const incomingCalls = Effect.fn("LSP.incomingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/incomingCalls")
    })

    const outgoingCalls = Effect.fn("LSP.outgoingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/outgoingCalls")
    })

    return Service.of({
      init,
      status,
      hasClients,
      touchFile,
      diagnostics,
      hover,
      definition,
      references,
      implementation,
      documentSymbol,
      workspaceSymbol,
      prepareCallHierarchy,
      incomingCalls,
      outgoingCalls,
    })
  }),
)

export * as Diagnostic from "./diagnostic"

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, RuntimeFlags.node, FSUtil.node, EventV2Bridge.node],
})

export * as LSP from "./lsp"

import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import {
  CancellationToken,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node"
import type { Diagnostic as VSCodeDiagnostic } from "vscode-languageserver-types"
import { stop } from "./launch"
import { LANGUAGE_EXTENSIONS } from "./language"
import { Effect, Schema } from "effect"
import type * as LSPServer from "./server"
import { withTimeout } from "../util/timeout"
import { Filesystem } from "@/util/filesystem"
import type { InstanceContext } from "@/project/instance-context"
import { request } from "./request"

const DIAGNOSTICS_DEBOUNCE_MS = 150
const DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS = 5_000
const DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS = 10_000
const DIAGNOSTICS_REQUEST_TIMEOUT_MS = 3_000

const INITIALIZE_TIMEOUT_MS = 45_000
const REQUEST_TIMEOUT_MS = 15_000
const IDLE_TIMEOUT_MS = 10 * 60_000
const MAX_DIAGNOSTIC_FILES = 1024
const MAX_DIAGNOSTIC_BYTES = 8 * 1024 * 1024

const navigationCapabilities: Record<string, string> = {
  "textDocument/hover": "hoverProvider",
  "textDocument/definition": "definitionProvider",
  "textDocument/references": "referencesProvider",
  "textDocument/implementation": "implementationProvider",
  "textDocument/documentSymbol": "documentSymbolProvider",
  "workspace/symbol": "workspaceSymbolProvider",
  "textDocument/prepareCallHierarchy": "callHierarchyProvider",
  "callHierarchy/incomingCalls": "callHierarchyProvider",
  "callHierarchy/outgoingCalls": "callHierarchyProvider",
}

// Per server: enough for an active working set without retaining an entire repo.
// UTF-16 bytes conservatively account for the retained JS strings. Active waits
// and requests may temporarily exceed these limits; trim as soon as they finish.
const MAX_OPEN_DOCUMENTS = 64
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

// LSP spec constants
const FILE_CHANGE_CHANGED = 2
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2

export type Info = NonNullable<Awaited<ReturnType<typeof create>>>

export type Diagnostic = VSCodeDiagnostic

export class InitializeError extends Schema.TaggedErrorClass<InitializeError>()("LSPInitializeError", {
  serverID: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

type DocumentDiagnosticReport = {
  items?: Diagnostic[]
  relatedDocuments?: Record<string, DocumentDiagnosticReport>
}

type WorkspaceDiagnosticReport = {
  items?: {
    uri?: string
    items?: Diagnostic[]
  }[]
}

type DiagnosticRequestResult = {
  handled: boolean
  matched: boolean
  byFile: Map<string, Diagnostic[]>
}

type CapabilityRegistration = {
  id: string
  method: string
  registerOptions?: {
    identifier?: string
    workspaceDiagnostics?: boolean
  }
}

type ServerCapabilities = {
  textDocumentSync?:
    | number
    | {
        change?: number
      }
  diagnosticProvider?: unknown
  [key: string]: unknown
}

function getFilePath(uri: string) {
  if (!uri.startsWith("file://")) return
  return Filesystem.normalizePath(fileURLToPath(uri))
}

function getSyncKind(capabilities?: ServerCapabilities) {
  if (!capabilities) return
  const sync = capabilities.textDocumentSync
  if (typeof sync === "number") return sync
  return sync?.change
}

function endPosition(text: string) {
  const lines = text.split(/\r\n|\r|\n/)
  return {
    line: lines.length - 1,
    character: lines.at(-1)?.length ?? 0,
  }
}

function dedupeDiagnostics(items: Diagnostic[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = JSON.stringify({
      code: item.code,
      severity: item.severity,
      message: item.message,
      source: item.source,
      range: item.range,
    })
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function configurationValue(settings: unknown, section?: string) {
  if (!section) return settings ?? null
  const result = section.split(".").reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object" || !(key in acc)) return undefined
    return (acc as Record<string, unknown>)[key]
  }, settings)
  return result ?? null
}

// TypeScript's built-in LSP pushes diagnostics aggressively on first open.
// We seed the push cache on the very first publish so waitForFreshPush can
// resolve immediately instead of waiting for a second debounced push.
function shouldSeedDiagnosticsOnFirstPush(serverID: string) {
  return serverID === "typescript"
}

export async function create(input: {
  serverID: string
  server: LSPServer.Handle
  root: string
  directory: string
  instance: InstanceContext
  idleTimeoutMs?: number
}) {
  const instance = input.instance

  const connection = createMessageConnection(
    new StreamMessageReader(input.server.process.stdout as any),
    new StreamMessageWriter(input.server.process.stdin as any),
  )
  input.server.process.stderr?.resume()
  // --- Connection state ---

  const pushDiagnostics = new Map<string, Diagnostic[]>()
  const pullDiagnostics = new Map<string, Diagnostic[]>()
  const published = new Map<string, { at: number; version?: number }>()
  const diagnosticRegistrations = new Map<string, CapabilityRegistration>()
  const registrationListeners = new Set<() => void>()
  const shutdownListeners = new Set<() => void>()
  const diagnosticListeners = new Set<(input: { path: string; serverID: string }) => void>()
  const files = new Map<string, { version: number; text: string; changedAt: number; pins: number; waited: boolean }>()
  const completedDiagnostics = new Map<string, { items: Diagnostic[]; timer: ReturnType<typeof setTimeout> }>()
  const diagnosticSizes = new Map<string, number>()
  let diagnosticBytes = 0
  const boundDiagnostics = (filePath: string) => {
    diagnosticBytes -= diagnosticSizes.get(filePath) ?? 0
    diagnosticSizes.delete(filePath)
    const size = JSON.stringify([pushDiagnostics.get(filePath), pullDiagnostics.get(filePath)]).length * 2
    diagnosticSizes.set(filePath, size)
    diagnosticBytes += size
    for (const [file, bytes] of diagnosticSizes) {
      if (diagnosticSizes.size <= MAX_DIAGNOSTIC_FILES && diagnosticBytes <= MAX_DIAGNOSTIC_BYTES) break
      if (files.has(file)) continue
      diagnosticSizes.delete(file)
      diagnosticBytes -= bytes
      pushDiagnostics.delete(file)
      pullDiagnostics.delete(file)
      published.delete(file)
    }
  }
  const mergedDiagnostics = (filePath: string) =>
    (!files.has(filePath) ? completedDiagnostics.get(filePath)?.items : undefined) ??
    dedupeDiagnostics([...(pushDiagnostics.get(filePath) ?? []), ...(pullDiagnostics.get(filePath) ?? [])])
  const updatePushDiagnostics = (filePath: string, next: Diagnostic[]) => {
    pushDiagnostics.set(filePath, next)
    boundDiagnostics(filePath)
    for (const listener of diagnosticListeners) listener({ path: filePath, serverID: input.serverID })
  }
  const updatePullDiagnostics = (filePath: string, next: Diagnostic[]) => {
    pullDiagnostics.set(filePath, next)
    boundDiagnostics(filePath)
  }
  const emitRegistrationChange = () => {
    for (const listener of [...registrationListeners]) listener()
  }

  // --- LSP connection handlers ---

  connection.onNotification("textDocument/publishDiagnostics", (params) => {
    const filePath = getFilePath(params.uri)
    if (!filePath) return
    const document = files.get(filePath)
    if (document && typeof params.version === "number" && params.version !== document.version) return
    published.set(filePath, {
      at: Date.now(),
      version: typeof params.version === "number" ? params.version : undefined,
    })
    if (shouldSeedDiagnosticsOnFirstPush(input.serverID) && !pushDiagnostics.has(filePath)) {
      pushDiagnostics.set(filePath, params.diagnostics)
      boundDiagnostics(filePath)
      return
    }
    updatePushDiagnostics(filePath, params.diagnostics)
  })
  connection.onRequest("window/workDoneProgress/create", (params) => {
    return null
  })
  connection.onRequest("workspace/configuration", async (params) => {
    const items = (params as { items?: { section?: string }[] }).items ?? []
    return items.map((item) => configurationValue(input.server.initialization, item.section))
  })
  connection.onRequest("client/registerCapability", async (params) => {
    const registrations = (params as { registrations?: CapabilityRegistration[] }).registrations ?? []
    let changed = false
    for (const registration of registrations) {
      diagnosticRegistrations.set(registration.id, registration)
      if (registration.method === "textDocument/diagnostic") changed = true
    }
    if (changed) emitRegistrationChange()
  })
  connection.onRequest("client/unregisterCapability", async (params) => {
    const registrations = (params as { unregisterations?: { id: string; method: string }[] }).unregisterations ?? []
    let changed = false
    for (const registration of registrations) {
      diagnosticRegistrations.delete(registration.id)
      if (registration.method === "textDocument/diagnostic") changed = true
    }
    if (changed) emitRegistrationChange()
  })
  connection.onRequest("workspace/workspaceFolders", async () => [
    {
      name: "workspace",
      uri: pathToFileURL(input.root).href,
    },
  ])
  connection.onRequest("workspace/diagnostic/refresh", async () => null)
  connection.listen()

  // --- Initialize handshake ---

  const initialized = await request(
    (token) =>
      connection.sendRequest<{ capabilities?: ServerCapabilities }>(
        "initialize",
        {
          rootUri: pathToFileURL(input.root).href,
          processId: process.pid,
          workspaceFolders: [
            {
              name: "workspace",
              uri: pathToFileURL(input.root).href,
            },
          ],
          initializationOptions: {
            ...input.server.initialization,
          },
          capabilities: {
            window: {
              workDoneProgress: true,
            },
            workspace: {
              configuration: true,
              didChangeWatchedFiles: {
                dynamicRegistration: true,
              },
              diagnostics: {
                refreshSupport: false,
              },
            },
            textDocument: {
              synchronization: {
                didOpen: true,
                didChange: true,
              },
              diagnostic: {
                dynamicRegistration: true,
                relatedDocumentSupport: true,
              },
              publishDiagnostics: {
                versionSupport: false,
              },
            },
          },
        },
        token,
      ),
    { timeout: INITIALIZE_TIMEOUT_MS },
  ).catch((err) => {
    connection.dispose()
    throw new InitializeError({ serverID: input.serverID, cause: err })
  })

  const syncKind = getSyncKind(initialized.capabilities)
  const hasStaticPullDiagnostics = Boolean(initialized.capabilities?.diagnosticProvider)

  await connection.sendNotification("initialized", {})

  if (input.server.initialization) {
    await connection.sendNotification("workspace/didChangeConfiguration", {
      settings: input.server.initialization,
    })
  }

  let bytes = 0
  let version = -1
  let stopping = false
  let shutdown: Promise<void> | undefined
  let activeRequests = 0
  const documentRequests = new Map<string, number>()
  let pendingOperations = 0
  let operations = Promise.resolve()
  let trimTimer: ReturnType<typeof setImmediate> | undefined
  const opening = new Set<string>()
  let openTimer: ReturnType<typeof setImmediate> | undefined
  const interrupted = new AbortController()
  let lastUsed = Date.now()
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  function activity() {
    lastUsed = Date.now()
  }

  function scheduleIdle() {
    if (stopping) return
    const timeout = input.idleTimeoutMs ?? IDLE_TIMEOUT_MS
    idleTimer = setTimeout(() => {
      const busy =
        activeRequests || documentRequests.size || pendingOperations || [...files.values()].some((doc) => doc.pins)
      if (busy || Date.now() - lastUsed < timeout) {
        scheduleIdle()
        return
      }
      void result.shutdown().catch((error) => Effect.runSync(Effect.logError("failed to stop idle LSP", error)))
    }, timeout)
    idleTimer.unref()
  }

  function supports(method: string) {
    const capability = navigationCapabilities[method]
    if (!capability) return true
    return (
      Boolean(initialized.capabilities?.[capability]) ||
      [...diagnosticRegistrations.values()].some(
        (registration) =>
          registration.method === method ||
          (method.startsWith("callHierarchy/") && registration.method === "textDocument/prepareCallHierarchy"),
      )
    )
  }

  function handoff(filePath: string) {
    // An already-queued open can start trimming before the previous open's
    // Promise has reached its caller. Protect that handoff for one event turn.
    opening.add(filePath)
    if (openTimer) return
    openTimer = setImmediate(() => {
      openTimer = undefined
      opening.clear()
      scheduleTrim()
    })
  }

  function serialize<T>(fn: () => Promise<T>) {
    pendingOperations++
    const task = operations.then(fn)
    operations = task.then(
      () => {
        pendingOperations--
      },
      () => {
        pendingOperations--
      },
    )
    return task
  }

  async function close(filePath: string) {
    const document = files.get(filePath)
    if (!document) return
    if (!stopping && document.waited && (pushDiagnostics.has(filePath) || pullDiagnostics.has(filePath))) {
      rememberDiagnostics(filePath)
    }
    await connection.sendNotification("textDocument/didClose", { textDocument: { uri: pathToFileURL(filePath).href } })
    files.delete(filePath)
    bytes -= document.text.length * 2
    published.delete(filePath)
    pushDiagnostics.delete(filePath)
    pullDiagnostics.delete(filePath)
    diagnosticBytes -= diagnosticSizes.get(filePath) ?? 0
    diagnosticSizes.delete(filePath)
  }

  function forgetDiagnostics(filePath: string) {
    const completed = completedDiagnostics.get(filePath)
    if (completed) clearTimeout(completed.timer)
    completedDiagnostics.delete(filePath)
  }

  function rememberDiagnostics(filePath: string) {
    // A faster server can close an oversized document while touchFile is still
    // waiting on another server. Retain only its completed diagnostic result,
    // never source text, for the bounded wait/collection handoff.
    forgetDiagnostics(filePath)
    completedDiagnostics.set(filePath, {
      items: mergedDiagnostics(filePath),
      timer: setTimeout(() => forgetDiagnostics(filePath), DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS),
    })
    if (completedDiagnostics.size > MAX_OPEN_DOCUMENTS) {
      const oldest = completedDiagnostics.keys().next().value
      if (oldest !== undefined) forgetDiagnostics(oldest)
    }
  }

  async function trim(protectedPath?: string) {
    if (stopping || activeRequests) return
    for (const [filePath, document] of files) {
      if (files.size <= MAX_OPEN_DOCUMENTS && bytes <= MAX_DOCUMENT_BYTES) break
      if (document.pins || opening.has(filePath) || documentRequests.has(filePath) || filePath === protectedPath)
        continue
      await close(filePath)
    }
  }

  function scheduleTrim() {
    if (stopping || trimTimer) return
    // Callers immediately following open() with a diagnostic wait get a chance
    // to pin the document before eviction (including a single oversized file).
    trimTimer = setImmediate(() => {
      trimTimer = undefined
      // Do not queue a trim directly behind an open that is still reading: that
      // could run before the open's caller resumes and pins its diagnostic wait.
      if (pendingOperations) {
        void operations.then(scheduleTrim)
        return
      }
      void serialize(() => trim()).catch((error) =>
        Effect.runSync(Effect.logError("failed to close idle LSP document", error)),
      )
    })
  }

  // Keep documents open until the response or cancellation/deadline. Workspace
  // requests pin the set; even an uncooperative server cannot pin it indefinitely.
  const sendRequest = connection.sendRequest.bind(connection)
  function dispatch<T>(args: unknown[], signal?: AbortSignal): Promise<T | null> {
    if (stopping) return Promise.reject(new Error("LSP client is shutting down"))
    const type = args[0] as string | { method: string }
    const method = typeof type === "string" ? type : type.method
    if (!supports(method)) return Promise.resolve(null)
    activity()
    const params = args[1] as { textDocument?: { uri?: string }; item?: { uri?: string } } | undefined
    const uri = params?.textDocument?.uri ?? params?.item?.uri
    const filePath = uri ? getFilePath(uri) : undefined
    if (filePath) documentRequests.set(filePath, (documentRequests.get(filePath) ?? 0) + 1)
    if (!filePath) activeRequests++
    const last = args.at(-1)
    const token = CancellationToken.is(last) ? last : undefined
    if (token) args.pop()
    const timeout =
      method === "textDocument/diagnostic" || method === "workspace/diagnostic"
        ? DIAGNOSTICS_REQUEST_TIMEOUT_MS
        : REQUEST_TIMEOUT_MS
    return request(
      async (token) => {
        // A query may arrive long after a background read's document was evicted.
        await operations
        if (token.isCancellationRequested) throw new Error("LSP request cancelled")
        if (filePath && !files.has(filePath)) await result.notify.open({ path: filePath })
        if (token.isCancellationRequested) throw new Error("LSP request cancelled")
        const transport = Reflect.apply(sendRequest, connection, [...args, token]) as Promise<T>
        const subscription = token.onCancellationRequested(() => {
          // A server that ignores cancellation retains pending JSON-RPC state
          // and may keep doing expensive work. Retire it after a short grace.
          void withTimeout(
            transport.then(
              () => {},
              () => {},
            ),
            1_000,
          ).catch(() => result.shutdown())
        })
        return await transport.finally(() => subscription.dispose())
      },
      { timeout, token, signal: signal ? AbortSignal.any([signal, interrupted.signal]) : interrupted.signal },
    ).finally(() => {
      if (filePath) {
        const count = (documentRequests.get(filePath) ?? 1) - 1
        if (count) documentRequests.set(filePath, count)
        if (!count) documentRequests.delete(filePath)
      }
      if (!filePath) activeRequests--
      activity()
      scheduleTrim()
    })
  }
  connection.sendRequest = new Proxy(sendRequest, {
    apply(_target, _thisArg, args) {
      return dispatch(args)
    },
  })

  // --- Diagnostic helpers ---

  const mergeResults = (filePath: string, results: DiagnosticRequestResult[]) => {
    const handled = results.some((result) => result.handled)
    const matched = results.some((result) => result.matched)
    if (!handled) return { handled: false, matched: false }

    const merged = new Map<string, Diagnostic[]>()
    for (const result of results) {
      for (const [target, items] of result.byFile.entries()) {
        const existing = merged.get(target) ?? []
        merged.set(target, existing.concat(items))
      }
    }

    if (matched && !merged.has(filePath)) merged.set(filePath, [])
    for (const [target, items] of merged.entries()) {
      updatePullDiagnostics(target, dedupeDiagnostics(items))
    }

    return { handled, matched }
  }

  async function requestDiagnosticReport(filePath: string, identifier?: string): Promise<DiagnosticRequestResult> {
    const version = files.get(filePath)?.version
    const report = await connection
      .sendRequest<DocumentDiagnosticReport | null>("textDocument/diagnostic", {
        ...(identifier ? { identifier } : {}),
        textDocument: {
          uri: pathToFileURL(filePath).href,
        },
      })
      .catch(() => null)
    if (!report || stopping || files.get(filePath)?.version !== version) {
      return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }
    }

    const byFile = new Map<string, Diagnostic[]>()
    const push = (target: string, items: Diagnostic[]) => {
      const existing = byFile.get(target) ?? []
      byFile.set(target, existing.concat(items))
    }

    let handled = false
    let matched = false
    if (Array.isArray(report.items)) {
      push(filePath, report.items)
      handled = true
      matched = true
    }
    for (const [uri, related] of Object.entries(report.relatedDocuments ?? {})) {
      const relatedPath = getFilePath(uri)
      if (!relatedPath || !Array.isArray(related.items)) continue
      push(relatedPath, related.items)
      handled = true
      matched = matched || relatedPath === filePath
    }

    return { handled, matched, byFile }
  }

  async function requestWorkspaceDiagnosticReport(
    filePath: string,
    identifier?: string,
  ): Promise<DiagnosticRequestResult> {
    const report = await connection
      .sendRequest<WorkspaceDiagnosticReport | null>("workspace/diagnostic", {
        ...(identifier ? { identifier } : {}),
        previousResultIds: [],
      })
      .catch(() => null)
    if (!report || stopping) return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }

    const byFile = new Map<string, Diagnostic[]>()
    let matched = false
    for (const item of report.items ?? []) {
      const relatedPath = item.uri ? getFilePath(item.uri) : undefined
      if (!relatedPath || !Array.isArray(item.items)) continue
      const existing = byFile.get(relatedPath) ?? []
      byFile.set(relatedPath, existing.concat(item.items))
      matched = matched || relatedPath === filePath
    }

    return { handled: true, matched, byFile }
  }

  function documentPullState() {
    const documentRegistrations = [...diagnosticRegistrations.values()].filter(
      (registration) =>
        registration.method === "textDocument/diagnostic" &&
        registration.registerOptions?.workspaceDiagnostics !== true,
    )
    return {
      documentIdentifiers: [
        ...new Set(documentRegistrations.flatMap((registration) => registration.registerOptions?.identifier ?? [])),
      ],
      supported: hasStaticPullDiagnostics || documentRegistrations.length > 0,
    }
  }

  function workspacePullState() {
    const workspaceRegistrations = [...diagnosticRegistrations.values()].filter(
      (registration) =>
        registration.method === "textDocument/diagnostic" &&
        registration.registerOptions?.workspaceDiagnostics === true,
    )
    return {
      workspaceIdentifiers: [
        ...new Set(workspaceRegistrations.flatMap((registration) => registration.registerOptions?.identifier ?? [])),
      ],
      supported: workspaceRegistrations.length > 0,
    }
  }

  const hasCurrentFileDiagnostics = (filePath: string, results: DiagnosticRequestResult[]) =>
    results.some((result) => (result.byFile.get(filePath)?.length ?? 0) > 0)

  async function requestDiagnostics(
    filePath: string,
    requests: Promise<DiagnosticRequestResult>[],
    done: (results: DiagnosticRequestResult[]) => boolean,
  ) {
    if (!requests.length) return { handled: false, matched: false }

    const results: DiagnosticRequestResult[] = []
    return new Promise<{ handled: boolean; matched: boolean }>((resolve) => {
      let pending = requests.length
      let resolved = false
      const finish = (merged: { handled: boolean; matched: boolean }, force = false) => {
        if (resolved) return
        if (!force && !done(results)) return
        resolved = true
        resolve(merged)
      }

      for (const request of requests) {
        request.then((result) => {
          results.push(result)
          pending -= 1
          const merged = mergeResults(filePath, results)
          finish(merged)
          if (pending === 0) finish(merged, true)
        })
      }
    })
  }

  // LATENCY-CRITICAL: dispatch identifier pulls in parallel and unblock once one
  // batch already produced diagnostics for the current file. Let slower pulls keep
  // merging in the background; do not sequence identifier-by-identifier, and do
  // not add a post-match settle/debounce delay. See PR #23771.
  async function requestDocumentDiagnostics(filePath: string) {
    const state = documentPullState()
    if (!state.supported) return { handled: false, matched: false }
    return requestDiagnostics(
      filePath,
      [
        requestDiagnosticReport(filePath),
        ...state.documentIdentifiers.map((identifier) => requestDiagnosticReport(filePath, identifier)),
      ],
      (results) => hasCurrentFileDiagnostics(filePath, results),
    )
  }

  async function requestFullDiagnostics(filePath: string) {
    const documentState = documentPullState()
    const workspaceState = workspacePullState()
    if (!documentState.supported && !workspaceState.supported) return { handled: false, matched: false }
    return mergeResults(
      filePath,
      await Promise.all([
        ...(documentState.supported ? [requestDiagnosticReport(filePath)] : []),
        ...documentState.documentIdentifiers.map((identifier) => requestDiagnosticReport(filePath, identifier)),
        ...(workspaceState.supported ? [requestWorkspaceDiagnosticReport(filePath)] : []),
        ...workspaceState.workspaceIdentifiers.map((identifier) =>
          requestWorkspaceDiagnosticReport(filePath, identifier),
        ),
      ]),
    )
  }

  function waitForRegistrationChange(timeout: number) {
    if (timeout <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: boolean) => {
        if (finished) return
        finished = true
        if (timer) clearTimeout(timer)
        registrationListeners.delete(listener)
        shutdownListeners.delete(cancel)
        resolve(result)
      }
      const listener = () => finish(true)
      const cancel = () => finish(false)
      registrationListeners.add(listener)
      shutdownListeners.add(cancel)
      timer = setTimeout(() => finish(false), timeout)
    })
  }

  function waitForFreshPush(request: { path: string; version: number; after: number; timeout: number }) {
    if (request.timeout <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let finished = false
      let debounceTimer: ReturnType<typeof setTimeout> | undefined
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined
      let unsub: (() => void) | undefined
      const finish = (result: boolean) => {
        if (finished) return
        finished = true
        if (debounceTimer) clearTimeout(debounceTimer)
        if (timeoutTimer) clearTimeout(timeoutTimer)
        unsub?.()
        shutdownListeners.delete(cancel)
        resolve(result)
      }
      const cancel = () => finish(false)
      shutdownListeners.add(cancel)
      const schedule = () => {
        const hit = published.get(request.path)
        if (!hit) return
        // A concurrent edit supersedes the requested snapshot. Wait for the
        // current document instead of a version the server will never publish.
        const current = files.get(request.path)
        const version = current?.version ?? request.version
        if (typeof hit.version === "number" && hit.version !== version) return
        if (hit.at < (current?.changedAt ?? request.after) && hit.version !== version) return
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => finish(true), Math.max(0, DIAGNOSTICS_DEBOUNCE_MS - (Date.now() - hit.at)))
      }

      timeoutTimer = setTimeout(() => finish(false), request.timeout)
      const listener = (event: { path: string; serverID: string }) => {
        if (event.path !== request.path || event.serverID !== input.serverID) return
        schedule()
      }
      diagnosticListeners.add(listener)
      unsub = () => diagnosticListeners.delete(listener)
      schedule()
    })
  }

  async function waitForDocumentDiagnostics(request: { path: string; version: number; after?: number }) {
    const startedAt = Date.now()
    const pushWait = waitForFreshPush({
      path: request.path,
      version: request.version,
      after: request.after ?? startedAt,
      timeout: DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS,
    })

    while (!stopping && Date.now() - startedAt < DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS) {
      const version = files.get(request.path)?.version
      const result = await requestDocumentDiagnostics(request.path)
      if (stopping) return
      if (files.get(request.path)?.version !== version) continue
      if (result.matched) return
      const remaining = DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS - (Date.now() - startedAt)
      if (remaining <= 0) return
      const next = await Promise.race([
        pushWait.then((ready) => (ready ? "push" : ("timeout" as const))),
        waitForRegistrationChange(remaining).then((changed) => (changed ? "registration" : ("timeout" as const))),
      ])
      if (next !== "registration") return
    }
  }

  async function waitForFullDiagnostics(request: { path: string; version: number; after?: number }) {
    const startedAt = Date.now()
    const pushWait = waitForFreshPush({
      path: request.path,
      version: request.version,
      after: request.after ?? startedAt,
      timeout: DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS,
    })

    while (!stopping && Date.now() - startedAt < DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS) {
      const version = files.get(request.path)?.version
      const result = await requestFullDiagnostics(request.path)
      if (stopping) return
      if (files.get(request.path)?.version !== version) continue
      if (result.handled || result.matched) return
      const remaining = DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS - (Date.now() - startedAt)
      if (remaining <= 0) return
      const next = await Promise.race([
        pushWait.then((ready) => (ready ? "push" : ("timeout" as const))),
        waitForRegistrationChange(remaining).then((changed) => (changed ? "registration" : ("timeout" as const))),
      ])
      if (next !== "registration") return
    }
  }

  // --- Public API ---

  const result = {
    root: input.root,
    get connected() {
      return !stopping && input.server.process.exitCode === null && input.server.process.signalCode === null
    },
    request<T>(method: string, params: unknown, signal?: AbortSignal) {
      return dispatch<T>([method, params], signal)
    },
    get serverID() {
      return input.serverID
    },
    get connection() {
      return connection
    },
    notify: {
      async open(request: { path: string }) {
        activity()
        const filePath = Filesystem.normalizePath(
          path.isAbsolute(request.path) ? request.path : path.resolve(input.directory, request.path),
        )
        return serialize(async () => {
          if (stopping) throw new Error("LSP client is shutting down")
          await trim(filePath)
          // Read inside the serialized operation: concurrent opens must not send
          // duplicate didOpen or overwrite a newer snapshot with an older read.
          const text = await Filesystem.readText(filePath)
          if (stopping) throw new Error("LSP client is shutting down")
          const document = files.get(filePath)
          if (document?.text === text) {
            files.delete(filePath)
            files.set(filePath, document)
            handoff(filePath)
            scheduleTrim()
            return document.version
          }

          const changedAt = Date.now()
          const next = ++version
          // Opening an existing file (including reopening after eviction) is not
          // a filesystem creation. No-op reads don't signal watched-file changes.
          await connection.sendNotification("workspace/didChangeWatchedFiles", {
            changes: [{ uri: pathToFileURL(filePath).href, type: FILE_CHANGE_CHANGED }],
          })
          published.delete(filePath)
          forgetDiagnostics(filePath)
          if (!document) {
            pushDiagnostics.delete(filePath)
            pullDiagnostics.delete(filePath)
          }
          files.delete(filePath)
          files.set(filePath, { version: next, text, changedAt, pins: document?.pins ?? 0, waited: false })
          bytes += (text.length - (document?.text.length ?? 0)) * 2
          if (document) {
            await connection.sendNotification("textDocument/didChange", {
              textDocument: { uri: pathToFileURL(filePath).href, version: next },
              contentChanges:
                syncKind === TEXT_DOCUMENT_SYNC_INCREMENTAL
                  ? [{ range: { start: { line: 0, character: 0 }, end: endPosition(document.text) }, text }]
                  : [{ text }],
            })
          }
          if (!document) {
            await connection.sendNotification("textDocument/didOpen", {
              textDocument: {
                uri: pathToFileURL(filePath).href,
                languageId: LANGUAGE_EXTENSIONS[path.extname(filePath) || path.basename(filePath)] ?? "plaintext",
                version: next,
                text,
              },
            })
          }
          handoff(filePath)
          scheduleTrim()
          return next
        })
      },
    },
    // Scoped retrieval must not materialize/deduplicate the whole workspace.
    diagnosticsFor(file: string) {
      if (!pushDiagnostics.has(file) && !pullDiagnostics.has(file) && !completedDiagnostics.has(file)) return undefined
      return mergedDiagnostics(file)
    },
    *diagnosticFiles() {
      yield* pushDiagnostics.keys()
      for (const file of pullDiagnostics.keys()) {
        if (!pushDiagnostics.has(file)) yield file
      }
      for (const file of completedDiagnostics.keys()) {
        if (!pushDiagnostics.has(file) && !pullDiagnostics.has(file)) yield file
      }
    },
    hasDiagnosticErrors(file: string) {
      const completed = !files.has(file) ? completedDiagnostics.get(file) : undefined
      if (completed) return completed.items.some((item) => item.severity === 1)
      return (
        pushDiagnostics.get(file)?.some((item) => item.severity === 1) ||
        pullDiagnostics.get(file)?.some((item) => item.severity === 1) ||
        false
      )
    },
    get diagnostics() {
      const result = new Map<string, Diagnostic[]>()
      for (const key of new Set([
        ...pushDiagnostics.keys(),
        ...pullDiagnostics.keys(),
        ...completedDiagnostics.keys(),
      ])) {
        result.set(key, mergedDiagnostics(key))
      }
      return result
    },
    async waitForDiagnostics(request: { path: string; version: number; mode?: "document" | "full"; after?: number }) {
      const normalizedPath = Filesystem.normalizePath(
        path.isAbsolute(request.path) ? request.path : path.resolve(input.directory, request.path),
      )
      if (stopping) return
      activity()
      const version = files.get(normalizedPath)?.version ?? (await result.notify.open({ path: normalizedPath }))
      const document = files.get(normalizedPath)
      if (!document) return
      if (
        document.waited &&
        !documentPullState().supported &&
        (request.mode === "document" || !workspacePullState().supported)
      )
        return
      document.pins++
      try {
        const wait = request.mode === "document" ? waitForDocumentDiagnostics : waitForFullDiagnostics
        await wait({ path: normalizedPath, version, after: document.changedAt })
        document.waited = true
      } finally {
        // A concurrent edit keeps the pin count on the current document.
        const current = files.get(normalizedPath)
        if (current) current.pins--
        scheduleTrim()
        activity()
      }
    },
    shutdown(): Promise<void> {
      if (shutdown) return shutdown
      shutdown = (async () => {
        stopping = true
        interrupted.abort(new Error("LSP client is shutting down"))
        if (idleTimer) clearTimeout(idleTimer)
        if (trimTimer) clearImmediate(trimTimer)
        if (openTimer) clearImmediate(openTimer)
        opening.clear()
        for (const cancel of shutdownListeners) cancel()
        await operations
        for (const filePath of files.keys()) {
          await close(filePath).catch((error) =>
            Effect.runSync(Effect.logDebug("LSP document close during shutdown failed", error)),
          )
        }
        // Use the original request function: the public connection now rejects
        // new work. The timeout bounds teardown of a nonresponsive server.
        await withTimeout(sendRequest("shutdown"), 1_000).catch(() => {})
        await connection.sendNotification("exit").catch(() => {})
        connection.end()
        connection.dispose()
        files.clear()
        for (const filePath of completedDiagnostics.keys()) forgetDiagnostics(filePath)
        bytes = 0
        pushDiagnostics.clear()
        pullDiagnostics.clear()
        published.clear()
        diagnosticSizes.clear()
        diagnosticBytes = 0
        diagnosticRegistrations.clear()
        diagnosticListeners.clear()
        registrationListeners.clear()
        await stop(input.server.process)
      })()
      return shutdown
    },
  }

  const disconnected = () => {
    void result.shutdown().catch((error) => Effect.runSync(Effect.logDebug("LSP disconnect cleanup failed", error)))
  }
  connection.onClose(disconnected)
  input.server.process.once("exit", disconnected)
  scheduleIdle()
  return result
}

export * as LSPClient from "./client"

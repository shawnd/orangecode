import {
  CancellationToken,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node"
import { watch } from "node:fs"
import path from "node:path"

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
)
const documents = new Map<string, { text: string; version: number }>()
const counts = { didOpen: 0, didChange: 0, didClose: 0, watched: 0, fulltextBytes: 0, peakDocuments: 0, peakBytes: 0 }
const violations: string[] = []
const events: { method: string; uri: string; version?: number; end?: unknown; languageId?: string }[] = []
let publish = true
let versioned = false
let hold = false
let holdIdentifier: string | undefined
let snapshotDiagnostics = false
let cancellations = 0
let ignoreCancellation = false
const pending: (() => void)[] = []
const diagnostic = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  message: "fixture diagnostic",
  severity: 1,
}
const bytes = () => [...documents.values()].reduce((sum, doc) => sum + Buffer.byteLength(doc.text), 0)
connection.onRequest("initialize", async () => {
  const ready = process.argv[2]
  const peer = process.argv[3]
  if (ready && peer) {
    await Bun.write(ready, "ready")
    await new Promise<void>((resolve) => {
      const watcher = watch(path.dirname(peer), async () => {
        if (!(await Bun.file(peer).exists())) return
        watcher.close()
        resolve()
      })
      void Bun.file(peer)
        .exists()
        .then((exists) => {
          if (!exists) return
          watcher.close()
          resolve()
        })
    })
  }
  return { capabilities: { textDocumentSync: { openClose: true, change: 2 }, hoverProvider: true } }
})

function held(token: CancellationToken) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      const index = pending.indexOf(finish)
      if (index !== -1) pending.splice(index, 1)
      subscription.dispose()
      resolve()
    }
    const subscription = token.onCancellationRequested(() => {
      cancellations++
      void connection.sendNotification("test/cancelled", {})
      if (!ignoreCancellation) finish()
    })
    pending.push(finish)
  })
}
connection.onNotification("workspace/didChangeWatchedFiles", () => counts.watched++)
for (const method of ["didOpen", "didChange", "didClose"] as const) {
  connection.onNotification(`textDocument/${method}`, (params) => {
    const doc = params.textDocument
    counts[method]++
    events.push({
      method,
      uri: doc.uri,
      version: doc.version,
      end: params.contentChanges?.[0]?.range?.end,
      languageId: doc.languageId,
    })
    if (method === "didClose") {
      if (!documents.delete(doc.uri)) violations.push("close without open")
      // Real servers can clear diagnostics when a document closes.
      connection.sendNotification("textDocument/publishDiagnostics", { uri: doc.uri, diagnostics: [] })
      return
    }
    if (method === "didOpen" && documents.has(doc.uri)) violations.push("duplicate open")
    if (method === "didChange" && !documents.has(doc.uri)) violations.push("change without open")
    if (method === "didChange" && doc.version <= (documents.get(doc.uri)?.version ?? -1))
      violations.push("non-increasing version")
    const text = method === "didOpen" ? doc.text : params.contentChanges[0].text
    counts.fulltextBytes += Buffer.byteLength(text)
    documents.set(doc.uri, { text, version: doc.version })
    counts.peakDocuments = Math.max(counts.peakDocuments, documents.size)
    counts.peakBytes = Math.max(counts.peakBytes, bytes())
    if (publish)
      connection.sendNotification("textDocument/publishDiagnostics", {
        uri: doc.uri,
        ...(versioned ? { version: doc.version } : {}),
        diagnostics: [diagnostic],
      })
  })
}
connection.onRequest("test/stats", () => ({
  ...counts,
  openDocuments: documents.size,
  retainedTextBytes: bytes(),
  violations,
}))
connection.onRequest("test/events", () => events)
connection.onRequest("test/configure", (params) => {
  publish = params.publish ?? publish
  versioned = params.versioned ?? versioned
  hold = params.hold ?? hold
  holdIdentifier = params.holdIdentifier ?? holdIdentifier
  snapshotDiagnostics = params.snapshotDiagnostics ?? snapshotDiagnostics
  ignoreCancellation = params.ignoreCancellation ?? ignoreCancellation
  return null
})
connection.onRequest("test/register", async (params) => {
  await connection.sendRequest("client/registerCapability", {
    registrations: (params?.identifiers ?? [undefined]).map((identifier: string | undefined, i: number) => ({
      id: `fixture-${i}`,
      method: "textDocument/diagnostic",
      registerOptions: { identifier },
    })),
  })
  return null
})
connection.onRequest("test/publish", async (params) => {
  await connection.sendNotification("textDocument/publishDiagnostics", params)
  return null
})
connection.onRequest("test/pending", () => pending.length)
connection.onRequest("test/cancellations", () => cancellations)
connection.onRequest("test/release", () => {
  pending.splice(0).forEach((resolve) => resolve())
  return null
})
connection.onRequest("textDocument/diagnostic", async (params, token) => {
  const items = [
    {
      ...diagnostic,
      message: snapshotDiagnostics ? (documents.get(params.textDocument.uri)?.text ?? "closed") : diagnostic.message,
    },
  ]
  await connection.sendNotification("test/pull-started", {})
  if (hold || (holdIdentifier && holdIdentifier === params.identifier)) await held(token)
  return { kind: "full", items }
})
connection.onRequest("textDocument/hover", async (params, token) => {
  await connection.sendNotification("test/hover-started", {})
  if (hold) await held(token)
  return { open: documents.has(params.textDocument.uri), text: documents.get(params.textDocument.uri)?.text }
})
connection.onRequest("shutdown", async () => {
  await connection.sendNotification("test/shutdown", { ...counts, openDocuments: documents.size })
  return null
})
connection.listen()

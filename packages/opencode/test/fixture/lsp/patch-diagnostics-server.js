// A real stdio peer: only the external language server is simulated.
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node.js"

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
)
const mode = process.argv[2] ?? "responsive"
const delay = mode === "slow" ? 250 : 10
const documents = new Map()
const stats = { initialize: 0, opens: 0, changes: 0, closes: 0, watched: 0, published: 0 }

connection.onRequest("initialize", () => {
  stats.initialize++
  return { capabilities: { textDocumentSync: { openClose: true, change: 1 } } }
})
connection.onNotification("workspace/didChangeWatchedFiles", () => stats.watched++)
function publish(document) {
  if (mode === "none") return
  // Wrong-version diagnostics must not complete the document wait.
  connection.sendNotification("textDocument/publishDiagnostics", {
    uri: document.uri,
    version: document.version - 1,
    diagnostics: [],
  })
  setTimeout(() => {
    stats.published++
    connection.sendNotification("textDocument/publishDiagnostics", {
      uri: document.uri,
      version: document.version,
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 1,
          message: `checked version ${document.version}: ${document.text.split("\n")[0].trim()}`,
        },
      ],
    })
  }, delay)
}
connection.onNotification("textDocument/didOpen", (params) => {
  stats.opens++
  documents.set(params.textDocument.uri, params.textDocument)
  publish(params.textDocument)
})
connection.onNotification("textDocument/didChange", (params) => {
  stats.changes++
  const document = { ...params.textDocument, text: params.contentChanges[0].text }
  documents.set(document.uri, document)
  publish(document)
})
connection.onNotification("textDocument/didClose", (params) => {
  stats.closes++
  documents.delete(params.textDocument.uri)
  connection.sendNotification("textDocument/publishDiagnostics", { uri: params.textDocument.uri, diagnostics: [] })
})
connection.onRequest("textDocument/hover", () => ({ ...stats, documents: [...documents.values()] }))
connection.listen()

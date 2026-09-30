import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"

const count = Number(process.argv[2] ?? 0)
const server = Number(process.argv[3] ?? 0)
const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout))
const diagnostic = (message: string, severity = 1) => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  severity,
  message,
  source: `fixture-${server}`,
})
const document = (uri: string) =>
  uri.includes("empty") ? [] : [diagnostic("affected error"), diagnostic("affected warning", 2)]

connection.onRequest("initialize", (params) => {
  const root = fileURLToPath(params.rootUri)
  // Sent before the initialize response, so readiness implies the population is loaded.
  for (const name of ["affected.diag", "second.diag"]) {
    const uri = pathToFileURL(path.join(root, name)).href
    void connection.sendNotification("textDocument/publishDiagnostics", { uri, diagnostics: document(uri) })
  }
  for (let i = 0; i < count; i++) {
    const uri = pathToFileURL(path.join(root, `unrelated-${String(i).padStart(5, "0")}.diag`)).href
    // The first file has only warnings on server 0, errors on server 1.
    const diagnostics = Array.from({ length: 24 }, (_, j) =>
      diagnostic(`unrelated ${i} issue ${j}`, i === 0 && server === 0 ? 2 : 1),
    )
    void connection.sendNotification("textDocument/publishDiagnostics", { uri, diagnostics })
  }
  return { capabilities: { textDocumentSync: 1, diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } }
})
connection.onRequest("textDocument/diagnostic", (params) => ({ kind: "full", items: document(params.textDocument.uri) }))
connection.onNotification("textDocument/didOpen", (params) => {
  void connection.sendNotification("textDocument/publishDiagnostics", {
    uri: params.textDocument.uri,
    version: params.textDocument.version,
    diagnostics: document(params.textDocument.uri),
  })
})
connection.onNotification("textDocument/didChange", (params) => {
  void connection.sendNotification("textDocument/publishDiagnostics", {
    uri: params.textDocument.uri,
    version: params.textDocument.version,
    diagnostics: document(params.textDocument.uri),
  })
})
connection.onRequest("shutdown", () => null)
connection.onNotification("exit", () => process.exit(0))
connection.listen()

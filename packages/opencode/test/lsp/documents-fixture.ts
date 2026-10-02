import { spawn } from "node:child_process"
import { LSPClient } from "@/lsp/client"
import { withTestInstance } from "../fixture/fixture"

export function documentClient(directory: string, options?: { idleTimeoutMs?: number }) {
  return withTestInstance({
    directory,
    fn: (instance) =>
      LSPClient.create({
        serverID: "documents-fixture",
        directory,
        root: directory,
        instance,
        ...options,
        server: {
          process: spawn(process.execPath, [new URL("../fixture/lsp/documents-server.ts", import.meta.url).pathname], {
            stdio: "pipe",
          }),
        },
      }),
  })
}

export type DocumentStats = {
  didOpen: number
  didChange: number
  didClose: number
  watched: number
  fulltextBytes: number
  openDocuments: number
  retainedTextBytes: number
  peakDocuments: number
  peakBytes: number
  violations: string[]
}

export async function stats(client: LSPClient.Info) {
  // Allow deferred idle eviction to finish before the protocol barrier.
  await new Promise<void>((resolve) => setImmediate(resolve))
  return client.connection.sendRequest<DocumentStats>("test/stats")
}

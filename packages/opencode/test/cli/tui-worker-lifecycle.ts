import assert from "node:assert/strict"
import { startTuiWorker } from "../../src/cli/cmd/tui"

const stuck = process.argv[2] === "stuck"
const worker = new URL(stuck ? "../fixture/tui-stuck-worker.ts" : "../../src/cli/tui/worker.ts", import.meta.url)

await startTuiWorker(
  worker,
  { hostname: "127.0.0.1", port: Number(process.argv[3]), cors: process.argv[4] ? [process.argv[4]] : [] },
  stuck ? 1000 : 10_000,
).then(
  async (transport) => {
    const response = await fetch(new URL("/global/health", transport.server.url))
    assert.equal(response.status, 200)
    await response.body?.cancel()
    await Promise.all([transport.client.call("shutdown", undefined), transport.client.call("shutdown", undefined)])
    assert.equal(
      await fetch(transport.server.url).then(
        () => true,
        () => false,
      ),
      false,
    )
    // Both callers must await the same complete shutdown, including termination.
    const first = transport.stop()
    const second = transport.stop()
    assert.equal(first, second)
    await Promise.all([first, second])
    await assert.rejects(transport.client.call("snapshot", undefined), /RPC client closed|Worker closed/)
    console.log("worker shutdown awaited", transport.server.url)
  },
  (error: unknown) => {
    if (!stuck) throw error
    assert.match(String(error), /TUI worker startup timed out/)
    console.log("stuck startup rejected after cleanup")
  },
)

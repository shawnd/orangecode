import { Rpc } from "../../src/util/rpc"

Rpc.listen({
  async server(input: { port: number; hostname: string; cors: string[] }) {
    Bun.serve({ hostname: input.hostname, port: input.port, fetch: () => new Response("stuck worker listener") })
    const response = await fetch(input.cors[0], { method: "POST" })
    await response.body?.cancel()
    return new Promise<never>(() => {})
  },
  shutdown() {
    // Exercise the fallback termination path, with an actual live socket to release.
    return new Promise<never>(() => {})
  },
})

import { Rpc } from "../../src/util/rpc"

if (process.env.RPC_TEST_STARTUP_ERROR === "true") throw new Error("worker initialization failed")

export const rpc = {
  echo(input: { value: string }) {
    return input.value
  },
  fail(input: { async: boolean; value?: string }) {
    if (input.value) throw input.value
    const error = Object.assign(new TypeError("worker method failed"), { code: "RPC_TEST" })
    if (input.async) return Promise.reject(error)
    throw error
  },
  circular() {
    const result = { self: {} }
    result.self = result
    return result
  },
  caused() {
    throw new Error("outer failure", { cause: Object.assign(new Error("bind failed"), { code: "EADDRINUSE" }) })
  },
  cyclicCause() {
    const error = new Error("cyclic cause")
    error.cause = error
    throw error
  },
  publish(input: { value: string }) {
    Rpc.emit("value", input.value)
  },
  block() {
    return new Promise<never>(() => {})
  },
  crash() {
    setTimeout(() => {
      throw new Error("worker crashed")
    }, 0)
  },
  close() {
    process.exit(0)
  },
}

Rpc.listen(rpc)

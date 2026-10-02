import { CancellationToken, CancellationTokenSource } from "vscode-jsonrpc/node"

// JSON-RPC cancellation is advisory. Bound the local wait too, even if the
// server ignores $/cancelRequest, so callers and document pins can be released.
export async function request<T>(
  send: (token: CancellationToken) => Promise<T>,
  options: { timeout: number; token?: CancellationToken; signal?: AbortSignal },
) {
  const source = new CancellationTokenSource()
  const cancelled = Promise.withResolvers<never>()
  const cancel = (reason: unknown) => {
    source.cancel()
    cancelled.reject(reason)
  }
  const abort = () => cancel(options.signal?.reason ?? new Error("LSP request interrupted"))
  const subscription = options.token?.onCancellationRequested(() => cancel(new Error("LSP request cancelled")))
  options.signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => cancel(new Error("LSP request timed out")), options.timeout)
  try {
    if (options.signal?.aborted || options.token?.isCancellationRequested) {
      throw new Error("LSP request cancelled")
    }
    return await Promise.race([send(source.token), cancelled.promise])
  } finally {
    clearTimeout(timer)
    subscription?.dispose()
    options.signal?.removeEventListener("abort", abort)
    source.dispose()
  }
}

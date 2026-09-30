import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createHerdrActivityReporter } from "../../util/herdr-activity"

export default {
  id: "opencode.herdr.activity",
  async tui(api) {
    const paneID = process.env.HERDR_PANE_ID
    const socketPath = process.env.HERDR_SOCKET_PATH
    if (process.env.HERDR_ENV !== "1" || !paneID || !socketPath) return
    let boundary: string | undefined
    const dispose = createHerdrActivityReporter({
      paneID,
      socketPath,
      current() {
        const route = api.route.current
        const id = route.name === "session" ? route.params?.sessionID : undefined
        if (typeof id !== "string" || !id) return boundary
        const seen = new Set<string>()
        let member: string | undefined = id
        while (member && !seen.has(member)) {
          if (member === boundary) return boundary
          seen.add(member)
          const session = api.state.session.get(member)
          // Wait for ancestry hydration rather than narrowing an active subtree.
          if (!session) return undefined
          member = session.parentID
        }
        if (member) return undefined
        boundary = id
        return boundary
      },
      async read(sessionID, signal) {
        const result = await api.client.session.activity({ sessionID }, { signal })
        if (!result.response.ok || !result.data) throw new Error("Session activity unavailable")
        return result.data
      },
    })
    api.lifecycle.onDispose(dispose)
  },
} satisfies TuiPluginModule

import { TuiThreadCommand } from "../../src/cli/cmd/tui"

// Explicit network flags select the owned worker instead of the shared daemon.
const port = Number(process.argv[3] ?? 0)
process.argv.push(`--port=${port}`)

if (typeof TuiThreadCommand.handler !== "function") throw new Error("Missing TUI handler")
await Promise.resolve(
  TuiThreadCommand.handler({
    $0: "oc",
    _: [],
    project: process.argv[2],
    session: "ses_00000000000000000000000000",
    mini: false,
    auto: false,
    yolo: false,
    "dangerously-skip-permissions": false,
    dangerouslySkipPermissions: false,
    port,
    hostname: "127.0.0.1",
    mdns: false,
    "mdns-domain": "opencode.local",
    mdnsDomain: "opencode.local",
    cors: [],
    agent: undefined,
    continue: undefined,
    fork: undefined,
    model: undefined,
    prompt: undefined,
    replay: undefined,
    "no-replay": undefined,
    noReplay: undefined,
    "replay-limit": undefined,
    replayLimit: undefined,
    demo: undefined,
  }),
).catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
  console.log("startup failure rejected")
})
console.log("invalid-session handler returned")

import { TuiThreadCommand } from "../../src/cli/cmd/tui"

// Explicit network flags select the owned worker instead of the shared daemon.
process.argv.push("--port=0")

if (typeof TuiThreadCommand.handler !== "function") throw new Error("Missing TUI handler")
await TuiThreadCommand.handler({
  $0: "oc",
  _: [],
  project: process.argv[2],
  session: "ses_00000000000000000000000000",
  mini: false,
  auto: false,
  yolo: false,
  "dangerously-skip-permissions": false,
  dangerouslySkipPermissions: false,
  port: 0,
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
})
console.log("invalid-session handler returned")

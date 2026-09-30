# Shared local server

Plain `oc` discovers a local background server and starts it automatically when
needed. Subsequent terminal clients reuse that process instead of starting their
own backend worker. `oc --mini` uses the same server.

## Lifecycle

- The server is detached from the launching terminal and survives client exits.
- Planned client-close behavior: interrupt the closing client's owned session
  trees after their last controlling client disconnects, while keeping the
  daemon and unrelated clients running. See [the integration plan](shared-client-close.md).
- `oc server status` reports its version, PID, and endpoint directory.
- `oc server start` starts or reuses it without opening a TUI.
- `oc server stop` shuts down the server and its active work. The next `oc`
  starts a fresh server. Stop waits for process exit; cleanup is bounded so a
  stuck plugin cannot leave an unreachable daemon running indefinitely.
- Concurrent launches serialize startup; a second ownership lock protects the
  server itself. Crashed-server sockets and endpoint metadata are replaced.
- Clients and servers may have different versions when their daemon protocol is
  compatible. A client rejects an incompatible protocol without stopping work.
  Stop the old server explicitly before reconnecting in that case.

Projects are selected per request using the existing directory header. Sessions,
providers, tools, and backend services live in the shared process; terminal
rendering and UI state remain client-local.

## Transport

Linux and macOS use HTTP and streaming events over a filesystem Unix socket in a
private directory under `XDG_RUNTIME_DIR`, falling back to the system temporary
directory. The directory is user-specific; the socket and credential file are
user-only. Windows uses an authenticated, ephemeral loopback HTTP listener.

The server creates random credentials and atomically publishes its endpoint in
`server.json`. Startup errors are written to `server.log` alongside the socket.
`OPENCODE_DAEMON_DIR` overrides the directory for isolated development/testing.

An additional authenticated loopback listener is opened lazily for existing
`oc attach <url>` clients, including clients launched in Herdr panes. It shares the same
backend service graph as the Unix listener.

## Configuration

Normal terminals share a server across project directories. Explicit config
overrides, XDG locations, database overrides, and `--pure` select separate
profiles. The server inherits its environment when it starts; restart it after
changing backend environment variables or credentials supplied through the
environment.

`oc serve`, `oc web`, and explicit network options on the TUI retain their
existing independently managed listener behavior. `oc run` retains its existing
noninteractive execution behavior.

## Client memory

The CLI registers command metadata eagerly and loads only the selected command's
implementation. TUI config, plugin runtime flags, and the TUI's global layer use
direct `LayerNode.compile(...)`: their dependencies are global-only and do not
need the location-service-map builder or its backend imports.

A controlled comparison with two idle clients in the same project measured:

| Build                                                            |   Client RSS |   Client PSS |
| ---------------------------------------------------------------- | -----------: | -----------: |
| Shared daemon, before client import reductions                   |     ~214 MiB |     ~164 MiB |
| Lazy command loading plus lightweight TUI layers, worktree build | ~175–178 MiB | ~129–132 MiB |

These measurements used compiled binaries, a 120×40 terminal, the same test
catalog, a local test-provider configuration, and disabled LSP/formatters/model
refresh. They describe idle clients, not a guaranteed bound for real projects.
RSS includes shared mapped pages; PSS apportions those pages between processes
and is a better measure when comparing many clients. Ordinary garbage collection
alone saved only roughly 1–2 MiB in the earlier client-entry probes.
The smaller temporary build of the same changes measured ~169–171 MiB RSS and
~127–129 MiB PSS; build options and runtime allocation timing also influence the
reported resident footprint. The `--mini` frontend still invokes the existing
run-command runtime and is not yet a fully isolated client-only bootstrap.

### Concurrent-session scaling work

Different sessions can execute concurrently; the execution coordinator serializes
only work for the same Session ID. Shared backend services avoid a fresh service
graph for each client, but active session histories, model request buffers, tool
results, subprocesses, and location-specific services still use additional memory.

The current TUI still subscribes to the global event stream. Both its legacy and
V2 stores can retain unseen-session transcript events. In an isolated experiment,
eight unseen sessions across two projects added about 10.7 MiB of text; both
clients grew, and a client heap snapshot retained the unseen payloads.

The next memory slices should separate globally useful session/status/pending
request metadata from subscribed transcript payloads, add byte/session budgets
and cache eviction with correct rehydration, and filter heavy events before
server-side subscriber queues and JSON serialization. Global control metadata
must remain available for session browsing and background subagent status.

Approval authority must be scoped independently: a TUI's `--auto` currently reacts
to global permission events, including events outside its viewed session tree.
Receiving an event must not by itself authorize automatic approval. The global
legacy SSE queue is also unbounded; merely setting a finite callback buffer would
silently drop events because its synchronous offer result is currently ignored.
Explicit overflow handling and resynchronization are required for a safe bound.

Multi-project MCP management needs the same location-aware refresh boundary:
global config edits currently refresh only the initiating directory's cached
config, and MCP change events can overwrite another location's displayed status.
Resource autocomplete also needs refresh alongside connection status. These are
follow-up integration issues, not fixed by the client import reductions above.

### Execution and memory benchmark

An isolated benchmark against the pre-client-reduction daemon used a local
HTTP/SSE test provider and two real PTY clients. Responses were held behind an
explicit gate until every expected Session reached the provider. Four sessions
in the same directory arrived within 400 ms and overlapped for 3.20 seconds.
Four real local `read` tool calls also completed, followed by overlapping model
continuations containing their results. The completed workload admitted 28
prompts and made 32 provider requests.

Representative median measurements from that run:

| State                                 | Daemon RSS | Daemon PSS | Client PSS, each |
| ------------------------------------- | ---------: | ---------: | ---------------: |
| Idle, two clients                     |   ~435 MiB |   ~388 MiB |     ~152–154 MiB |
| Four empty sessions                   |   ~437 MiB |   ~390 MiB |     ~152–154 MiB |
| Warm, one session active              |   ~442 MiB |   ~396 MiB |     ~149–151 MiB |
| First four-session round active       |   ~489 MiB |   ~442 MiB |     ~149–151 MiB |
| Four read-tool continuations active   |   ~546 MiB |   ~500 MiB |     ~150–152 MiB |
| Four enlarged-history sessions active |   ~580 MiB |   ~534 MiB |     ~172–176 MiB |
| Final idle, about ten seconds settled |   ~525 MiB |   ~479 MiB |     ~162–165 MiB |

Empty sessions cost little compared with executing turns. Active histories,
request serialization, tool definitions/results, streams, and buffers account
for additional working memory. Both clients grew when large unseen prompt
events arrived while they remained on the home view.

These results do not establish a fixed memory cost per conversation: daemon PSS
dropped about 75 MiB while a request remained active, and different idle settling
intervals changed the measured baseline substantially. Runtime and allocator
reclamation must be separated from genuinely retained state in longer tests.
The optional second-directory pass proved cross-location overlap, but both
directories had the global project identity; it did not measure separate Git
projects' service-graph overhead.

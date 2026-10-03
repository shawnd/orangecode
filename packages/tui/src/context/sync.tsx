import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
  SnapshotFileDiff,
  ConsoleState,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "./project"
import { useEvent } from "./event"
import { useSDK } from "./sdk"
import { useTuiStartup } from "./runtime"
import { createSimpleContext } from "./helper"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, createEffect, onCleanup, onMount } from "solid-js"
import { useRoute } from "./route"
import path from "path"
import { useKV } from "./kv"
import { usePermission } from "./permission"
import { isSessionNotFound } from "../util/error"
import { createDiffBootstrap } from "./diff-bootstrap"

const emptyConsoleState: ConsoleState = {
  consoleManagedProviders: [],
  switchableOrgCount: 0,
}

function search<T>(items: T[], target: string, key: (item: T) => string) {
  let left = 0
  let right = items.length - 1
  while (left <= right) {
    const middle = Math.floor((left + right) / 2)
    const value = key(items[middle])
    if (value === target) return { found: true, index: middle }
    if (value < target) left = middle + 1
    else right = middle - 1
  }
  return { found: false, index: left }
}

function compareMessage(a: Message, b: Message) {
  return a.time.created - b.time.created || a.id.localeCompare(b.id)
}

const messageKey = (message: Message) => message.time.created + message.id

export const {
  context: SyncContext,
  use: useSync,
  provider: SyncProvider,
} = createSimpleContext({
  name: "Sync",
  eager: () => Boolean(useTuiStartup().earlyInput),
  init: () => {
    const startup = useTuiStartup()
    const kv = useKV()
    const permission = usePermission()
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      console_state: ConsoleState
      capabilities: {
        experimentalBackgroundSubagents: boolean
      }
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: SnapshotFileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      capabilities: {
        experimentalBackgroundSubagents: false,
      },
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()
    const route = useRoute()
    createEffect(() => sdk.interest.select(route.data.type === "session" ? route.data.sessionID : undefined))

    const fullSyncedSessions = new Set<string>()
    const syncingSessions = new Map<string, Promise<void>>()
    const hydratingSessions = new Map<
      string,
      { epoch: number; messages: Set<string>; parts: Set<string>; touched: Set<string> }
    >()
    let recovering:
      | {
          permission: Set<string>
          v2permission: Set<string>
          question: Set<string>
          status: Set<string>
          removed: Set<string>
        }
      | undefined
    const requestLocations = new Map<string, { directory: string; workspace?: string }>()
    const statusVersions = new Map<string, number>()
    let statusSnapshot = 0
    const touchMessage = (sessionID: string, messageID: string) => {
      hydratingSessions.get(sessionID)?.messages.add(messageID)
    }
    const touchPart = (sessionID: string, partID: string) => {
      hydratingSessions.get(sessionID)?.parts.add(partID)
    }
    onCleanup(
      sdk.interest.onRemove((sessionID) => {
        recovering?.removed.add(sessionID)
        fullSyncedSessions.delete(sessionID)
        syncingSessions.delete(sessionID)
        hydratingSessions.delete(sessionID)
        requestLocations.delete(sessionID)
        statusVersions.delete(sessionID)
        setStore(
          produce((draft) => {
            draft.session = draft.session.filter((session) => session.id !== sessionID)
            for (const message of draft.message[sessionID] ?? []) delete draft.part[message.id]
            delete draft.message[sessionID]
            delete draft.todo[sessionID]
            delete draft.session_diff[sessionID]
            delete draft.session_status[sessionID]
            delete draft.permission[sessionID]
            delete draft.question[sessionID]
          }),
        )
      }),
    )
    onCleanup(
      sdk.interest.onChange(() => {
        setStore(
          produce((draft) => {
            for (const sessionID of new Set([...Object.keys(draft.message), ...hydratingSessions.keys()])) {
              if (sdk.interest.includes(sessionID)) continue
              for (const message of draft.message[sessionID] ?? []) delete draft.part[message.id]
              delete draft.message[sessionID]
              delete draft.todo[sessionID]
              delete draft.session_diff[sessionID]
              fullSyncedSessions.delete(sessionID)
              syncingSessions.delete(sessionID)
              hydratingSessions.delete(sessionID)
            }
          }),
        )
      }),
    )

    function sessionListQuery(): { scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      return {
        path: path
          .relative(path.resolve(project.data.instance.path.worktree), project.data.instance.path.directory)
          .replaceAll("\\", "/"),
      }
    }

    function listSessions() {
      return sdk.client.session
        .list({ start: Date.now() - 30 * 24 * 60 * 60 * 1000, ...sessionListQuery() })
        .then((x) => {
          const sessions = (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id))
          sessions.forEach((session) => sdk.interest.observe(session))
          return sessions
        })
    }

    event.subscribe((event, { directory, workspace }) => {
      if (
        (event.type.startsWith("permission.") ||
          event.type.startsWith("question.") ||
          event.type === "session.status") &&
        "sessionID" in event.properties &&
        typeof event.properties.sessionID === "string"
      )
        requestLocations.set(event.properties.sessionID, { directory, workspace })
      if (event.type === "permission.asked") recovering?.permission.add(event.properties.id)
      if (event.type === "permission.replied") recovering?.permission.add(event.properties.requestID)
      if (event.type === "permission.v2.asked") recovering?.v2permission.add(event.properties.id)
      if (event.type === "permission.v2.replied") recovering?.v2permission.add(event.properties.requestID)
      if (event.type === "question.asked") recovering?.question.add(event.properties.id)
      if (event.type === "question.replied" || event.type === "question.rejected")
        recovering?.question.add(event.properties.requestID)
      if (event.type === "session.status") {
        recovering?.status.add(event.properties.sessionID)
        statusVersions.set(event.properties.sessionID, (statusVersions.get(event.properties.sessionID) ?? 0) + 1)
      }
      const properties = event.properties as {
        sessionID?: string
        info?: { sessionID?: string }
        part?: { sessionID?: string }
      }
      const transcriptSession = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID
      if (
        (event.type.startsWith("message.") || event.type === "todo.updated" || event.type === "session.diff") &&
        transcriptSession &&
        !sdk.interest.includes(transcriptSession)
      )
        return
      switch (event.type) {
        case "permission.v2.asked": {
          if (permission.mode !== "auto" || !sdk.interest.owns(event.properties.sessionID)) break
          void sdk.client.v2.session.permission.reply({
            sessionID: event.properties.sessionID,
            requestID: event.properties.id,
            reply: "once",
          })
          break
        }
        case "server.instance.disposed":
          void bootstrap()
          break
        case "mcp.tools.changed":
          if (initialBootstrap.deferred()) break
          void Promise.all([
            sdk.client.mcp.status({}, { throwOnError: true }),
            sdk.client.experimental.resource.list({}, { throwOnError: true }),
          ])
            .then(([status, resources]) => {
              setStore("mcp", reconcile(status.data))
              setStore("mcp_resource", reconcile(resources.data))
            })
            .catch((error) => console.error("Failed to refresh MCP status:", error))
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          const request = event.properties
          if (permission.mode === "auto" && sdk.interest.owns(request.sessionID)) {
            void sdk.client.permission.reply({
              requestID: request.id,
              reply: "once",
              directory,
              workspace,
            })
            break
          }
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          hydratingSessions.get(event.properties.sessionID)?.touched.add("todo")
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          hydratingSessions.get(event.properties.sessionID)?.touched.add("diff")
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.updated": {
          hydratingSessions.get(event.properties.info.id)?.touched.add("info")
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.next.moved": {
          const result = search(store.session, event.properties.sessionID, (s) => s.id)
          if (!result.found) break
          hydratingSessions.get(event.properties.sessionID)?.touched.add("info")
          setStore(
            "session",
            result.index,
            produce((session) => {
              session.directory = event.properties.location.directory
              session.path = event.properties.subdirectory
              session.workspaceID = event.properties.location.workspaceID
              session.time.updated = event.properties.timestamp
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          touchMessage(event.properties.info.sessionID, event.properties.info.id)
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = search(messages, messageKey(event.properties.info), messageKey)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          if (updated.length > 100) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          touchMessage(event.properties.sessionID, event.properties.messageID)
          const messages = store.message[event.properties.sessionID]
          const index = messages?.findIndex((message) => message.id === event.properties.messageID) ?? -1
          if (index !== -1) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          touchPart(event.properties.part.sessionID, event.properties.part.id)
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = search(parts, event.properties.part.id, (part) => part.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = search(parts ?? [], event.properties.partID, (part) => part.id)
          if (!result.found) break
          touchPart(event.properties.sessionID, event.properties.partID)
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
              const field = event.properties.field as keyof typeof part
              const existing = part[field] as string | undefined
              ;(part[field] as string) = (existing ?? "") + event.properties.delta
            }),
          )
          break
        }

        case "message.part.removed": {
          touchPart(event.properties.sessionID, event.properties.partID)
          const parts = store.part[event.properties.messageID]
          const result = search(parts ?? [], event.properties.partID, (part) => part.id)
          if (result.found) {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }

        case "lsp.updated": {
          if (initialBootstrap.deferred()) break
          const workspace = project.workspace.current()
          void sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data ?? []))
          break
        }

        case "vcs.branch.updated": {
          if (workspace === project.workspace.current()) {
            vcsVersion++
            setStore("vcs", { branch: event.properties.branch })
          }
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()
    let bootstrapVersion = 0
    let vcsVersion = 0
    const initialBootstrap = createDiffBootstrap(
      () => void bootstrap({ backgroundCatalog: true }),
      Boolean(args.diff && !args.continue && !args.sessionID && !args.fork),
    )

    async function refreshVcs() {
      const version = ++vcsVersion
      const workspace = project.workspace.current()
      const epoch = sdk.connectionEpoch
      const response = await sdk.client.vcs.get({ workspace })
      if (version !== vcsVersion || epoch !== sdk.connectionEpoch || workspace !== project.workspace.current()) return
      setStore("vcs", reconcile(response.data))
    }

    async function bootstrap(input: { fatal?: boolean; backgroundCatalog?: boolean } = {}) {
      if (initialBootstrap.deferred())
        return refreshVcs().catch((error) => console.error("Failed to refresh VCS metadata:", error))
      const version = ++bootstrapVersion
      const fatal = input.fatal ?? true
      const workspace = project.workspace.current()
      const projectPromise = project.sync()
      const sessionListPromise = projectPromise.then(() => listSessions())

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.config.providers({ workspace }, { throwOnError: true })
      const capabilitiesPromise = sdk.client.experimental.capabilities
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => undefined)
      const consoleStatePromise = sdk.client.experimental.console
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => emptyConsoleState)
      const agentsPromise = sdk.client.app.agents({ workspace }, { throwOnError: true })
      const configPromise = sdk.client.config.get({ workspace }, { throwOnError: true })
      await Promise.all([
        providersPromise,
        capabilitiesPromise,
        agentsPromise,
        configPromise,
        projectPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ])
        .then(async () => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const capabilitiesResponse = capabilitiesPromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            capabilitiesResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const capabilities = responses[1]
            const agents = responses[2]
            const config = responses[3]
            const sessions = responses[4]
            if (version !== bootstrapVersion) return

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              // Connected models are sufficient for a usable session. Keep any
              // existing disconnected catalog entries until the full refresh.
              setStore(
                "provider_next",
                reconcile({
                  all: [
                    ...providers.providers,
                    ...store.provider_next.all.filter((item) => !providers.providers.some((p) => p.id === item.id)),
                  ],
                  default: providers.default,
                  connected: providers.providers.map((item) => item.id),
                }),
              )
              setStore("capabilities", "experimentalBackgroundSubagents", capabilities?.backgroundSubagents === true)
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(async () => {
          if (version !== bootstrapVersion) return
          if (store.status !== "complete") setStore("status", "partial")
          const catalog = sdk.client.provider.list({ workspace }, { throwOnError: true }).then((x) => {
            if (version === bootstrapVersion) setStore("provider_next", reconcile(x.data))
          })
          // non-blocking
          void Promise.all([
            catalog,
            ...(args.continue ? [] : [sessionListPromise.then((sessions) => setStore("session", reconcile(sessions)))]),
            consoleStatePromise.then((consoleState) => {
              if (version === bootstrapVersion) setStore("console_state", reconcile(consoleState))
            }),
            sdk.client.command.list({ workspace }).then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", reconcile(x.data ?? []))),
            sdk.client.mcp.status({}).then((x) => setStore("mcp", reconcile(x.data ?? {}))),
            sdk.client.experimental.resource.list({}).then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status({ workspace }).then((x) => setStore("formatter", reconcile(x.data ?? []))),
            (async () => {
              const epoch = sdk.connectionEpoch
              const snapshot = statusSnapshot
              const versions = new Map(statusVersions)
              const response = await sdk.client.session.status({ workspace }, { throwOnError: true })
              sdk.flushEvents()
              if (epoch !== sdk.connectionEpoch || snapshot !== statusSnapshot) return
              setStore(
                "session_status",
                reconcile({
                  ...Object.fromEntries(
                    Object.entries(response.data).filter(([id]) => versions.get(id) === statusVersions.get(id)),
                  ),
                  ...Object.fromEntries(
                    Object.entries(store.session_status).filter(([id]) => versions.get(id) !== statusVersions.get(id)),
                  ),
                }),
              )
            })(),
            sdk.client.provider.auth({ workspace }).then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            refreshVcs(),
            project.workspace.sync(),
          ])
            .then(() => {
              if (version === bootstrapVersion) setStore("status", "complete")
            })
            .catch((error) => {
              console.error("tui background bootstrap failed", error)
            })
          // Explicit refresh callers (e.g. provider authorization) still observe
          // the full catalog on return, while initial readiness is already partial.
          if (!input.backgroundCatalog) await catalog
        })
        .catch(async (e) => {
          console.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          if (fatal) {
            exit(e)
          } else {
            throw e
          }
        })
    }

    onMount(() => {
      if (initialBootstrap.deferred()) void bootstrap({ backgroundCatalog: true })
    })

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        // Keep this provider mounted on the first close, even while the newly
        // admitted bootstrap is loading. Readiness is not a completed snapshot.
        if (initialBootstrap.initial) return true
        if (startup.skipInitialLoading) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        get(sessionID: string) {
          const match = search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        query() {
          return sessionListQuery()
        },
        async refresh() {
          const list = await listSessions()
          setStore("session", reconcile(list))
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string, info?: Session) {
          await sdk.streamReady()
          if (!sdk.interest.includes(sessionID)) return
          if (fullSyncedSessions.has(sessionID)) return
          const syncing =
            hydratingSessions.get(sessionID)?.epoch === sdk.connectionEpoch ? syncingSessions.get(sessionID) : undefined
          if (syncing) return syncing
          const tracker = {
            epoch: sdk.connectionEpoch,
            messages: new Set<string>(),
            parts: new Set<string>(),
            touched: new Set<string>(),
          }
          hydratingSessions.set(sessionID, tracker)
          const task = (async () => {
            // History can render while sidebar details are still loading. Keep
            // both branches in the same task so callers still await a full sync.
            await Promise.all([
              Promise.all([
                info
                  ? Promise.resolve({ data: info })
                  : sdk.client.session.get({ sessionID }, { throwOnError: true }).catch((error: unknown) => {
                      if (!isSessionNotFound(error, sessionID, true)) throw error
                      sdk.flushEvents()
                      if (tracker.epoch === sdk.connectionEpoch && hydratingSessions.get(sessionID) === tracker)
                        sdk.interest.remove(sessionID)
                    }),
                sdk.client.session.messages({ sessionID, limit: 100 }),
              ]).then(([session, messages]) => {
                sdk.flushEvents()
                if (
                  !session ||
                  tracker.epoch !== sdk.connectionEpoch ||
                  !sdk.interest.includes(sessionID) ||
                  hydratingSessions.get(sessionID) !== tracker
                )
                  return
                setStore(
                  produce((draft) => {
                    const match = search(draft.session, sessionID, (s) => s.id)
                    if (!tracker.touched.has("info")) {
                      if (match.found) draft.session[match.index] = session.data!
                      if (!match.found) draft.session.splice(match.index, 0, session.data!)
                    }
                    const currentMessages = draft.message[sessionID] ?? []
                    const infos = (messages.data ?? []).flatMap((message) => {
                      if (!tracker.messages.has(message.info.id)) return [message.info]
                      const current = currentMessages.find((item) => item.id === message.info.id)
                      return current ? [current] : []
                    })
                    infos.push(
                      ...currentMessages.filter(
                        (message) => tracker.messages.has(message.id) && !infos.some((item) => item.id === message.id),
                      ),
                    )
                    infos.sort(compareMessage)
                    const removed = infos.slice(0, -100)
                    const visible = infos.slice(-100)
                    const visibleIDs = new Set(visible.map((message) => message.id))
                    for (const message of messages.data ?? []) {
                      if (!visibleIDs.has(message.info.id)) {
                        delete draft.part[message.info.id]
                        continue
                      }
                      const currentParts = draft.part[message.info.id] ?? []
                      const parts = message.parts.flatMap((part) => {
                        const current = currentParts.find((item) => item.id === part.id)
                        if (tracker.parts.has(part.id)) return current ? [current] : []
                        if (
                          current &&
                          (part.type === "text" || part.type === "reasoning") &&
                          (current.type === "text" || current.type === "reasoning") &&
                          part.text.length === 0 &&
                          current.text.length > 0
                        ) {
                          return [current]
                        }
                        return [part]
                      })
                      parts.push(
                        ...currentParts.filter(
                          (part) => tracker.parts.has(part.id) && !parts.some((item) => item.id === part.id),
                        ),
                      )
                      draft.part[message.info.id] = parts
                    }
                    for (const message of removed) delete draft.part[message.id]
                    draft.message[sessionID] = visible
                  }),
                )
              }),
              Promise.all([sdk.client.session.todo({ sessionID }), sdk.client.session.diff({ sessionID })]).then(
                ([todo, diff]) => {
                  sdk.flushEvents()
                  if (
                    tracker.epoch !== sdk.connectionEpoch ||
                    !sdk.interest.includes(sessionID) ||
                    hydratingSessions.get(sessionID) !== tracker
                  )
                    return
                  batch(() => {
                    if (!tracker.touched.has("todo")) setStore("todo", sessionID, reconcile(todo.data ?? []))
                    if (!tracker.touched.has("diff")) setStore("session_diff", sessionID, reconcile(diff.data ?? []))
                  })
                },
              ),
            ])
            if (
              tracker.epoch === sdk.connectionEpoch &&
              sdk.interest.includes(sessionID) &&
              hydratingSessions.get(sessionID) === tracker
            )
              fullSyncedSessions.add(sessionID)
          })().finally(() => {
            if (hydratingSessions.get(sessionID) !== tracker) return
            syncingSessions.delete(sessionID)
            hydratingSessions.delete(sessionID)
          })
          syncingSessions.set(sessionID, task)
          return task
        },
      },
      bootstrap,
    }
    onCleanup(
      sdk.onRecovery(async (epoch) => {
        if (initialBootstrap.deferred() && !sdk.interest.query() && requestLocations.size === 0) return refreshVcs()
        fullSyncedSessions.clear()
        const tracker = {
          permission: new Set<string>(),
          v2permission: new Set<string>(),
          question: new Set<string>(),
          status: new Set<string>(),
          removed: new Set<string>(),
        }
        recovering = tracker
        const workspace = project.workspace.current()
        const controlled = [
          ...new Set([
            ...store.session.map((session) => session.id),
            ...requestLocations.keys(),
            ...sdk.interest.query().split(",").filter(Boolean),
          ]),
        ].filter((id) => sdk.interest.owns(id))
        await Promise.all([
          (async () => {
            const locations = [
              ...new Map(
                [
                  { directory: sdk.directory, workspace },
                  ...store.session.map((session) => ({ directory: session.directory, workspace: session.workspaceID })),
                  ...requestLocations.values(),
                ].map((location) => [JSON.stringify(location), location]),
              ).values(),
            ]
            const snapshots = await Promise.all(
              locations.map(async (location) => {
                const [permissions, questions, statuses] = await Promise.all([
                  sdk.client.permission.list(location, { throwOnError: true }),
                  sdk.client.question.list(location, { throwOnError: true }),
                  sdk.client.session.status(location, { throwOnError: true }),
                ])
                return { location, permissions: permissions.data, questions: questions.data, statuses: statuses.data }
              }),
            )
            sdk.flushEvents()
            if (epoch !== sdk.connectionEpoch || recovering !== tracker) return
            statusSnapshot++
            setStore(
              produce((draft) => {
                const pending = snapshots
                  .flatMap((snapshot) => snapshot.permissions)
                  .filter((item) => !tracker.removed.has(item.sessionID) && !tracker.permission.has(item.id))
                pending.push(
                  ...Object.values(draft.permission)
                    .flat()
                    .filter((item) => !tracker.removed.has(item.sessionID) && tracker.permission.has(item.id)),
                )
                draft.permission = Object.groupBy(
                  [...new Map(pending.map((item) => [item.id, item])).values()].toSorted((a, b) =>
                    a.id.localeCompare(b.id),
                  ),
                  (item) => item.sessionID,
                ) as Record<string, PermissionRequest[]>
                const asked = snapshots
                  .flatMap((snapshot) => snapshot.questions)
                  .filter((item) => !tracker.removed.has(item.sessionID) && !tracker.question.has(item.id))
                asked.push(
                  ...Object.values(draft.question)
                    .flat()
                    .filter((item) => !tracker.removed.has(item.sessionID) && tracker.question.has(item.id)),
                )
                draft.question = Object.groupBy(
                  [...new Map(asked.map((item) => [item.id, item])).values()].toSorted((a, b) =>
                    a.id.localeCompare(b.id),
                  ),
                  (item) => item.sessionID,
                ) as Record<string, QuestionRequest[]>
                draft.session_status = {
                  ...Object.fromEntries(
                    snapshots
                      .flatMap((snapshot) => Object.entries(snapshot.statuses))
                      .filter(([id]) => !tracker.removed.has(id)),
                  ),
                  ...Object.fromEntries(
                    Object.entries(draft.session_status).filter(
                      ([id]) => !tracker.removed.has(id) && tracker.status.has(id),
                    ),
                  ),
                }
              }),
            )
            sdk.interest.reconcileStatus(store.session_status)
            const pending = [
              ...new Map(
                snapshots.flatMap((snapshot) =>
                  snapshot.permissions.map(
                    (request) => [request.id, { request, location: snapshot.location }] as const,
                  ),
                ),
              ).values(),
            ]
            for (const item of pending) {
              sdk.flushEvents()
              if (epoch !== sdk.connectionEpoch) return
              if (
                permission.mode !== "auto" ||
                tracker.removed.has(item.request.sessionID) ||
                !sdk.interest.owns(item.request.sessionID) ||
                tracker.permission.has(item.request.id)
              )
                continue
              await sdk.client.permission.reply(
                { requestID: item.request.id, reply: "once", ...item.location },
                { throwOnError: true },
              )
              if (epoch !== sdk.connectionEpoch) return
              setStore("permission", item.request.sessionID, (items = []) =>
                items.filter((request) => request.id !== item.request.id),
              )
            }
          })(),
          ...(permission.mode === "auto"
            ? controlled.map(async (sessionID) => {
                const missing = (error: unknown) => {
                  sdk.flushEvents()
                  if (tracker.removed.has(sessionID)) return
                  if (!isSessionNotFound(error, sessionID)) throw error
                  if (epoch === sdk.connectionEpoch && recovering === tracker) sdk.interest.remove(sessionID)
                }
                const response = await sdk.client.v2.session.permission
                  .list({ sessionID }, { throwOnError: true })
                  .catch(missing)
                sdk.flushEvents()
                if (
                  !response ||
                  epoch !== sdk.connectionEpoch ||
                  recovering !== tracker ||
                  tracker.removed.has(sessionID) ||
                  !sdk.interest.owns(sessionID)
                )
                  return
                for (const request of response.data.data) {
                  sdk.flushEvents()
                  if (epoch !== sdk.connectionEpoch || tracker.removed.has(sessionID) || !sdk.interest.owns(sessionID))
                    return
                  if (tracker.v2permission.has(request.id)) continue
                  await sdk.client.v2.session.permission
                    .reply({ sessionID, requestID: request.id, reply: "once" }, { throwOnError: true })
                    .catch(missing)
                }
              })
            : []),
          ...[
            ...new Set([
              ...store.session.map((session) => session.id),
              ...hydratingSessions.keys(),
              ...Object.keys(store.message),
            ]),
          ]
            .filter((id) => sdk.interest.includes(id))
            .map((id) => result.session.sync(id)),
        ]).finally(() => {
          if (recovering === tracker) recovering = undefined
        })
      }),
    )
    return result
  },
})

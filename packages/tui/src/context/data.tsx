import type {
  AgentV2Info,
  CommandV2Info,
  IntegrationInfo,
  LocationRef,
  ModelV2Info,
  PermissionSavedInfo,
  PermissionV2Request,
  ProviderV2Info,
  QuestionV2Request,
  ReferenceInfo,
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionV2Info,
  SkillV2Info,
  V2Event,
} from "@opencode-ai/sdk/v2"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { useEvent } from "./event"
import { createSignal, onCleanup, onMount } from "solid-js"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { createRefresh } from "../util/refresh"
import { isSessionNotFound } from "../util/error"

type LocationData = {
  agent?: AgentV2Info[]
  command?: CommandV2Info[]
  integration?: IntegrationInfo[]
  model?: ModelV2Info[]
  provider?: ProviderV2Info[]
  reference?: ReferenceInfo[]
  skill?: SkillV2Info[]
}

type Data = {
  session: {
    info: Record<string, SessionV2Info>
    message: Record<string, SessionMessage[]>
    permission: Record<string, PermissionV2Request[]>
    question: Record<string, QuestionV2Request[]>
  }
  project: {
    permission: Record<string, PermissionSavedInfo[]>
  }
  location: Record<string, LocationData>
}

function locationKey(location: LocationRef) {
  return JSON.stringify([location.directory, location.workspaceID])
}

function locationQuery(ref?: LocationRef) {
  return ref ? { directory: ref.directory, workspace: ref.workspaceID } : undefined
}

function fragmentKey(event: V2Event) {
  const data = event.data
  if (!("assistantMessageID" in data)) return
  if ("textID" in data) return JSON.stringify([data.assistantMessageID, "text", data.textID])
  if ("reasoningID" in data) return JSON.stringify([data.assistantMessageID, "reasoning", data.reasoningID])
  if ("callID" in data && event.type.startsWith("session.next.tool.input."))
    return JSON.stringify([data.assistantMessageID, "input", data.callID])
}

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: () => {
    const [store, setStore] = createStore<Data>({
      session: {
        info: {},
        message: {},
        permission: {},
        question: {},
      },
      project: {
        permission: {},
      },
      location: {},
    })

    const sdk = useSDK()
    const events = useEvent()
    const sequences = new Map<string, number>()
    const hydrating = new Map<
      string,
      { epoch: number; events: { sequence: number; durable: boolean; event: V2Event }[]; task?: Promise<void> }
    >()
    const volatile = new Map<string, V2Event[]>()
    let recovering: { permission: Set<string>; question: Set<string>; removed: Set<string> } | undefined
    const requestLocations = new Map<string, LocationRef>()
    onCleanup(
      sdk.interest.onRemove((sessionID) => {
        recovering?.removed.add(sessionID)
        hydrating.delete(sessionID)
        sequences.delete(sessionID)
        volatile.delete(sessionID)
        requestLocations.delete(sessionID)
        setStore(
          "session",
          produce((draft) => {
            delete draft.info[sessionID]
            delete draft.message[sessionID]
            delete draft.permission[sessionID]
            delete draft.question[sessionID]
          }),
        )
      }),
    )
    const durableTypes = new Set<string>(SessionEvent.DurableDefinitions.map((definition) => definition.type))
    const versionedTypes = new Set(
      SessionEvent.DurableDefinitions.map((definition) => `${definition.type}.${definition.durable?.version}`),
    )
    const [defaultLocation, setDefaultLocation] = createSignal<LocationRef>({
      directory: sdk.directory ?? process.cwd(),
    })
    const refresh = createRefresh()

    function resource<Key extends keyof LocationData>(
      name: Key,
      load: (ref?: LocationRef) => Promise<{ data: { location: LocationRef; data: NonNullable<LocationData[Key]> } }>,
    ) {
      const read = (ref?: LocationRef, invalidate = false) =>
        refresh(
          JSON.stringify([locationKey(ref ?? defaultLocation()), name]),
          async () => {
            const response = await load(ref)
            const key = locationKey(response.data.location)
            if (!store.location[key]) setStore("location", key, {})
            setStore(
              "location",
              key,
              produce((draft) => {
                draft[name] = response.data.data
              }),
            )
          },
          invalidate,
        )
      return {
        list(ref?: LocationRef) {
          return store.location[locationKey(ref ?? defaultLocation())]?.[name]
        },
        refresh: (ref?: LocationRef) => read(ref),
        invalidate: (ref?: LocationRef) => read(ref, true),
      }
    }

    const message = {
      update(sessionID: string, fn: (messages: SessionMessage[]) => void) {
        setStore(
          "session",
          "message",
          produce((draft) => {
            fn((draft[sessionID] ??= []))
          }),
        )
      },
      prepend(messages: SessionMessage[], item: SessionMessage) {
        if (messages.some((existing) => existing.id === item.id)) return
        messages.unshift(item)
      },
      activeAssistant(messages: SessionMessage[]) {
        const item = messages.find((item) => item.type === "assistant" && !item.time.completed)
        return item?.type === "assistant" ? item : undefined
      },
      assistant(messages: SessionMessage[], messageID: string) {
        const item = messages.find((item) => item.type === "assistant" && item.id === messageID)
        return item?.type === "assistant" ? item : undefined
      },
      activeShell(messages: SessionMessage[], callID: string) {
        const item = messages.find((item) => item.type === "shell" && item.callID === callID)
        return item?.type === "shell" ? item : undefined
      },
      latestTool(assistant: SessionMessageAssistant | undefined, callID?: string) {
        return assistant?.content.findLast(
          (item): item is SessionMessageAssistantTool =>
            item.type === "tool" && (callID === undefined || item.id === callID),
        )
      },
      latestText(assistant: SessionMessageAssistant | undefined, textID: string) {
        return assistant?.content.findLast(
          (item): item is SessionMessageAssistantText => item.type === "text" && item.id === textID,
        )
      },
      latestReasoning(assistant: SessionMessageAssistant | undefined, reasoningID: string) {
        return assistant?.content.findLast(
          (item): item is SessionMessageAssistantReasoning => item.type === "reasoning" && item.id === reasoningID,
        )
      },
    }

    function handleEvent(event: V2Event) {
      if (
        (event.type.startsWith("permission.v2.") || event.type.startsWith("question.v2.")) &&
        "sessionID" in event.data &&
        typeof event.data.sessionID === "string" &&
        event.location
      )
        requestLocations.set(event.data.sessionID, event.location)
      if (
        event.type.startsWith("session.next.") &&
        "sessionID" in event.data &&
        typeof event.data.sessionID === "string" &&
        !sdk.interest.includes(event.data.sessionID)
      )
        return
      switch (event.type) {
        case "permission.v2.asked":
          recovering?.permission.add(event.data.id)
          setStore("session", "permission", event.data.sessionID, (items = []) => [
            ...items.filter((item) => item.id !== event.data.id),
            event.data,
          ])
          break
        case "permission.v2.replied":
          recovering?.permission.add(event.data.requestID)
          setStore("session", "permission", event.data.sessionID, (items = []) =>
            items.filter((item) => item.id !== event.data.requestID),
          )
          break
        case "question.v2.asked":
          recovering?.question.add(event.data.id)
          setStore("session", "question", event.data.sessionID, (items = []) => [
            ...items.filter((item) => item.id !== event.data.id),
            event.data,
          ])
          break
        case "question.v2.replied":
        case "question.v2.rejected":
          recovering?.question.add(event.data.requestID)
          setStore("session", "question", event.data.sessionID, (items = []) =>
            items.filter((item) => item.id !== event.data.requestID),
          )
          break
        case "catalog.updated":
          void Promise.all([
            result.location.model.invalidate(event.location),
            result.location.provider.invalidate(event.location),
          ]).catch((error) => console.error("Failed to refresh catalog", error))
          break
        case "session.next.agent.switched":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "agent-switched",
              agent: event.data.agent,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.model.switched":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "model-switched",
              model: event.data.model,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.prompted": {
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "user",
              text: event.data.prompt.text,
              files: event.data.prompt.files,
              agents: event.data.prompt.agents,
              time: { created: event.data.timestamp },
            })
          })
          break
        }
        case "session.next.prompt.admitted":
          break
        case "session.next.context.updated":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "system",
              text: event.data.text,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.synthetic":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "synthetic",
              sessionID: event.data.sessionID,
              text: event.data.text,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.shell.started":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "shell",
              callID: event.data.callID,
              command: event.data.command,
              output: "",
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.shell.ended":
          message.update(event.data.sessionID, (draft) => {
            const match = message.activeShell(draft, event.data.callID)
            if (!match) return
            match.output = event.data.output
            match.time.completed = event.data.timestamp
          })
          break
        case "session.next.step.started":
          message.update(event.data.sessionID, (draft) => {
            if (draft.some((message) => message.id === event.data.assistantMessageID)) return
            const currentAssistant = message.activeAssistant(draft)
            if (currentAssistant) currentAssistant.time.completed = event.data.timestamp
            message.prepend(draft, {
              id: event.data.assistantMessageID,
              type: "assistant",
              agent: event.data.agent,
              model: event.data.model,
              content: [],
              snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.step.ended":
          message.update(event.data.sessionID, (draft) => {
            const currentAssistant = message.assistant(draft, event.data.assistantMessageID)
            if (!currentAssistant) return
            currentAssistant.time.completed = event.data.timestamp
            currentAssistant.finish = event.data.finish
            currentAssistant.cost = event.data.cost
            currentAssistant.tokens = event.data.tokens
            if (event.data.snapshot)
              currentAssistant.snapshot = { ...currentAssistant.snapshot, end: event.data.snapshot }
          })
          break
        case "session.next.step.failed":
          message.update(event.data.sessionID, (draft) => {
            const currentAssistant = message.assistant(draft, event.data.assistantMessageID)
            if (!currentAssistant) return
            currentAssistant.time.completed = event.data.timestamp
            currentAssistant.finish = "error"
            currentAssistant.error = event.data.error
          })
          break
        case "session.next.text.started":
          message.update(event.data.sessionID, (draft) => {
            message.assistant(draft, event.data.assistantMessageID)?.content.push({
              type: "text",
              id: event.data.textID,
              text: "",
            })
          })
          break
        case "session.next.text.delta":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestText(message.assistant(draft, event.data.assistantMessageID), event.data.textID)
            if (match) match.text += event.data.delta
          })
          break
        case "session.next.text.ended":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestText(message.assistant(draft, event.data.assistantMessageID), event.data.textID)
            if (match) match.text = event.data.text
          })
          break
        case "session.next.tool.input.started":
          message.update(event.data.sessionID, (draft) => {
            message.assistant(draft, event.data.assistantMessageID)?.content.push({
              type: "tool",
              id: event.data.callID,
              name: event.data.name,
              time: { created: event.data.timestamp },
              state: { status: "pending", input: "" },
            })
          })
          break
        case "session.next.tool.input.delta":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (match?.state.status === "pending") match.state.input += event.data.delta
          })
          break
        case "session.next.tool.input.ended":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (match?.state.status === "pending") match.state.input = event.data.text
          })
          break
        case "session.next.tool.called":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (!match) return
            match.time.ran = event.data.timestamp
            match.provider = event.data.provider
            match.state = { status: "running", input: event.data.input, structured: {}, content: [] }
          })
          break
        case "session.next.tool.progress":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (match?.state.status !== "running") return
            match.state.structured = event.data.structured
            match.state.content = [...event.data.content]
          })
          break
        case "session.next.tool.success":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (match?.state.status !== "running") return
            match.state = {
              status: "completed",
              input: match.state.input,
              structured: event.data.structured,
              content: [...event.data.content],
              result: event.data.result,
            }
            match.provider = {
              executed: event.data.provider.executed || match.provider?.executed === true,
              metadata: match.provider?.metadata,
              resultMetadata: event.data.provider.metadata,
            }
            match.time.completed = event.data.timestamp
          })
          break
        case "session.next.tool.failed":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (!match || (match.state.status !== "pending" && match.state.status !== "running")) return
            match.state = {
              status: "error",
              error: event.data.error,
              input: typeof match.state.input === "string" ? {} : match.state.input,
              structured: match.state.status === "running" ? match.state.structured : {},
              content: match.state.status === "running" ? match.state.content : [],
              result: event.data.result,
            }
            match.provider = {
              executed: event.data.provider.executed || match.provider?.executed === true,
              metadata: match.provider?.metadata,
              resultMetadata: event.data.provider.metadata,
            }
            match.time.completed = event.data.timestamp
          })
          break
        case "session.next.reasoning.started":
          message.update(event.data.sessionID, (draft) => {
            message.assistant(draft, event.data.assistantMessageID)?.content.push({
              type: "reasoning",
              id: event.data.reasoningID,
              text: "",
              providerMetadata: event.data.providerMetadata,
            })
          })
          break
        case "session.next.reasoning.delta":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestReasoning(
              message.assistant(draft, event.data.assistantMessageID),
              event.data.reasoningID,
            )
            if (match) match.text += event.data.delta
          })
          break
        case "session.next.reasoning.ended":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestReasoning(
              message.assistant(draft, event.data.assistantMessageID),
              event.data.reasoningID,
            )
            if (match) {
              match.text = event.data.text
              if (event.data.providerMetadata !== undefined) match.providerMetadata = event.data.providerMetadata
            }
          })
          break
        case "session.next.retried":
        case "session.next.compaction.started":
        case "session.next.compaction.delta":
          break
        case "session.next.compaction.ended":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "compaction",
              reason: event.data.reason,
              summary: event.data.text,
              recent: event.data.recent,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "reference.updated":
          void result.location.reference
            .invalidate(event.location)
            .catch((error) => console.error("Failed to refresh references", error))
          break
        case "integration.updated":
          void Promise.all([
            result.location.integration.invalidate(event.location),
            result.location.model.invalidate(event.location),
            result.location.provider.invalidate(event.location),
          ]).catch((error) => console.error("Failed to refresh integrations", error))
          break
      }
    }
    onCleanup(
      sdk.interest.onChange(() =>
        setStore(
          "session",
          "message",
          produce((draft) => {
            for (const sessionID of new Set([...Object.keys(draft), ...hydrating.keys()])) {
              if (sdk.interest.includes(sessionID)) continue
              delete draft[sessionID]
              hydrating.delete(sessionID)
              sequences.delete(sessionID)
              volatile.delete(sessionID)
            }
          }),
        ),
      ),
    )

    onMount(() => {
      const unsub = events.subscribe((event, metadata) => {
        if (sdk.selective && durableTypes.has(event.type)) return
        const current = {
          ...event,
          data: event.properties,
          location: { directory: metadata.directory, workspaceID: metadata.workspace },
        } as V2Event
        if (
          sdk.selective &&
          event.type.startsWith("session.next.") &&
          "sessionID" in event.properties &&
          typeof event.properties.sessionID === "string"
        ) {
          if (event.type.endsWith(".delta") && fragmentKey(current)) {
            const pending = volatile.get(event.properties.sessionID) ?? []
            pending.push(current)
            volatile.set(event.properties.sessionID, pending)
          }
          hydrating.get(event.properties.sessionID)?.events.push({
            sequence: sequences.get(event.properties.sessionID) ?? -1,
            durable: false,
            event: current,
          })
        }
        handleEvent(current)
      })
      onCleanup(unsub)
      onCleanup(
        sdk.event.on("event", (envelope) => {
          if (!sdk.selective || envelope.payload.type !== "sync") return
          const sync = envelope.payload.syncEvent
          if (!versionedTypes.has(sync.type) || !sdk.interest.includes(sync.aggregateID)) return
          if (sync.seq <= (sequences.get(sync.aggregateID) ?? -1)) return
          const event = {
            type: sync.type.replace(/\.\d+$/, ""),
            data: sync.data,
            location: { directory: envelope.directory, workspaceID: envelope.workspace },
          } as V2Event
          if (
            "sessionID" in event.data &&
            typeof event.data.sessionID === "string" &&
            event.type.endsWith(".ended") &&
            fragmentKey(event)
          ) {
            volatile.set(
              event.data.sessionID,
              (volatile.get(event.data.sessionID) ?? []).filter(
                (pending) => fragmentKey(pending) !== fragmentKey(event),
              ),
            )
          }
          const tracker = hydrating.get(sync.aggregateID)
          tracker?.events.push({ sequence: sync.seq, durable: true, event })
          handleEvent(event)
          sequences.set(sync.aggregateID, sync.seq)
        }),
      )
    })

    const result = {
      session: {
        get(sessionID: string) {
          return store.session.info[sessionID]
        },
        async refresh(sessionID: string) {
          await sdk.streamReady()
          const epoch = sdk.connectionEpoch
          const result = await sdk.client.v2.session.get({ sessionID }, { throwOnError: true })
          if (epoch !== sdk.connectionEpoch) return
          setStore("session", "info", sessionID, result.data.data)
        },
        message: {
          list(sessionID: string) {
            return store.session.message[sessionID]
          },
          async refresh(sessionID: string) {
            await sdk.streamReady()
            if (!sdk.interest.includes(sessionID)) return
            const current = hydrating.get(sessionID)
            if (current?.epoch === sdk.connectionEpoch) return current.task
            const tracker: {
              epoch: number
              events: { sequence: number; durable: boolean; event: V2Event }[]
              task?: Promise<void>
            } = {
              epoch: sdk.connectionEpoch,
              events: (volatile.get(sessionID) ?? []).map((event) => ({ sequence: -1, durable: false, event })),
            }
            hydrating.set(sessionID, tracker)
            tracker.task = (async () => {
              const response = await sdk.client.v2.session
                .messages({ sessionID }, { throwOnError: true })
                .catch((error: unknown) => {
                  if (!isSessionNotFound(error, sessionID)) throw error
                  sdk.flushEvents()
                  if (tracker.epoch === sdk.connectionEpoch && hydrating.get(sessionID) === tracker)
                    sdk.interest.remove(sessionID)
                })
              sdk.flushEvents()
              if (
                !response ||
                tracker.epoch !== sdk.connectionEpoch ||
                !sdk.interest.includes(sessionID) ||
                hydrating.get(sessionID) !== tracker
              )
                return
              if (sdk.selective && response.data.sequence === undefined) {
                throw new Error("Selective Session hydration requires a server snapshot sequence")
              }
              const sequence = response.data.sequence ?? -1
              const settled = new Set(
                tracker.events
                  .filter(
                    (pending) =>
                      pending.durable && pending.sequence <= sequence && pending.event.type.endsWith(".ended"),
                  )
                  .map((pending) => fragmentKey(pending.event)),
              )
              // Determine representation before installing the response: Solid store
              // updates can mutate its objects while replaying multiple deltas.
              const replay = tracker.events.filter((pending) => {
                if (pending.durable) return true
                const key = fragmentKey(pending.event)
                if (key && settled.has(key)) return false
                const data = pending.event.data
                return !response.data.data.some((item) => {
                  if (
                    item.type !== "assistant" ||
                    !("assistantMessageID" in data) ||
                    item.id !== data.assistantMessageID
                  )
                    return false
                  return item.content.some((part) => {
                    if (part.type === "text" && "textID" in data) return part.id === data.textID && part.text !== ""
                    if (part.type === "reasoning" && "reasoningID" in data)
                      return part.id === data.reasoningID && part.text !== ""
                    if (part.type === "tool" && "callID" in data)
                      return part.id === data.callID && (part.state.status !== "pending" || part.state.input !== "")
                    return false
                  })
                })
              })
              setStore("session", "message", sessionID, response.data.data)
              sequences.set(sessionID, sequence)
              // Replay only commits newer than the atomic snapshot. Delayed older
              // stream events are rejected by the sequence floor above.
              for (const pending of replay) {
                if (!pending.durable) {
                  // A different fragment's commit does not persist this fragment's
                  // deltas. Full-value settlement, rather than the aggregate floor,
                  // determines whether volatile output is already represented.
                  handleEvent(pending.event)
                  continue
                }
                if (pending.sequence <= (sequences.get(sessionID) ?? sequence)) continue
                handleEvent(pending.event)
                sequences.set(sessionID, pending.sequence)
              }
            })().finally(() => {
              if (hydrating.get(sessionID) === tracker) hydrating.delete(sessionID)
            })
            return tracker.task
          },
        },
        permission: {
          list(sessionID: string) {
            return store.session.permission[sessionID]
          },
          async refresh(sessionID: string) {
            await sdk.streamReady()
            const epoch = sdk.connectionEpoch
            const result = await sdk.client.v2.session.permission.list({ sessionID }, { throwOnError: true })
            if (epoch !== sdk.connectionEpoch) return
            setStore("session", "permission", sessionID, result.data.data)
          },
        },
        question: {
          list(sessionID: string) {
            return store.session.question[sessionID]
          },
          async refresh(sessionID: string) {
            await sdk.streamReady()
            const epoch = sdk.connectionEpoch
            const result = await sdk.client.v2.session.question.list({ sessionID }, { throwOnError: true })
            if (epoch !== sdk.connectionEpoch) return
            setStore("session", "question", sessionID, result.data.data)
          },
        },
      },
      project: {
        permission: {
          list(projectID: string) {
            return store.project.permission[projectID]
          },
          async refresh(projectID: string) {
            const result = await sdk.client.v2.permission.saved.list({ projectID }, { throwOnError: true })
            setStore("project", "permission", projectID, result.data.data)
          },
        },
      },
      location: {
        default() {
          return defaultLocation()
        },
        async refresh(ref?: LocationRef) {
          const response = await sdk.client.v2.location.get({ location: locationQuery(ref) }, { throwOnError: true })
          const location = response.data
          const key = locationKey(location)
          if (!store.location[key]) setStore("location", key, {})
          if (!ref) setDefaultLocation({ directory: location.directory, workspaceID: location.workspaceID })
        },
        agent: resource("agent", (ref) =>
          sdk.client.v2.agent.list({ location: locationQuery(ref) }, { throwOnError: true }),
        ),
        command: resource("command", (ref) =>
          sdk.client.v2.command.list({ location: locationQuery(ref) }, { throwOnError: true }),
        ),
        integration: resource("integration", (ref) =>
          sdk.client.v2.integration.list({ location: locationQuery(ref) }, { throwOnError: true }),
        ),
        model: resource("model", (ref) =>
          sdk.client.v2.model.list({ location: locationQuery(ref) }, { throwOnError: true }),
        ),
        provider: resource("provider", (ref) =>
          sdk.client.v2.provider.list({ location: locationQuery(ref) }, { throwOnError: true }),
        ),
        reference: resource("reference", (ref) =>
          sdk.client.v2.reference.list({ location: locationQuery(ref) }, { throwOnError: true }),
        ),
        skill: resource("skill", (ref) =>
          sdk.client.v2.skill.list({ location: locationQuery(ref) }, { throwOnError: true }),
        ),
      },
    }

    onCleanup(
      sdk.onRecovery(async (epoch) => {
        const tracker = { permission: new Set<string>(), question: new Set<string>(), removed: new Set<string>() }
        recovering = tracker
        const sessions = [
          ...new Set([
            ...Object.keys(store.session.message),
            ...Object.keys(store.session.permission),
            ...Object.keys(store.session.question),
            ...hydrating.keys(),
            ...sdk.interest.query().split(",").filter(Boolean),
          ]),
        ]
        await Promise.all([
          (async () => {
            const locations = [
              ...new Map(
                [
                  defaultLocation(),
                  ...Object.values(store.session.info).map((session) => session.location),
                  ...requestLocations.values(),
                ].map((location) => [locationKey(location), location]),
              ).values(),
            ]
            const [snapshots, owned] = await Promise.all([
              Promise.all(
                locations.map(async (ref) => {
                  const [permissions, questions] = await Promise.all([
                    sdk.client.v2.permission.request.list({ location: locationQuery(ref) }, { throwOnError: true }),
                    sdk.client.v2.question.request.list({ location: locationQuery(ref) }, { throwOnError: true }),
                  ])
                  return { permissions: permissions.data.data, questions: questions.data.data }
                }),
              ),
              Promise.all(
                sessions.map(async (sessionID) => {
                  const requests = await Promise.all([
                    sdk.client.v2.session.permission.list({ sessionID }, { throwOnError: true }),
                    sdk.client.v2.session.question.list({ sessionID }, { throwOnError: true }),
                  ]).catch((error: unknown) => {
                    sdk.flushEvents()
                    if (tracker.removed.has(sessionID)) return
                    if (!isSessionNotFound(error, sessionID)) throw error
                    if (epoch === sdk.connectionEpoch && recovering === tracker) sdk.interest.remove(sessionID)
                  })
                  sdk.flushEvents()
                  if (!requests || tracker.removed.has(sessionID)) return { permissions: [], questions: [] }
                  return { permissions: requests[0].data.data, questions: requests[1].data.data }
                }),
              ),
            ])
            sdk.flushEvents()
            if (epoch !== sdk.connectionEpoch || recovering !== tracker) return
            setStore(
              "session",
              produce((draft) => {
                const pending = [...snapshots, ...owned]
                  .flatMap((item) => item.permissions)
                  .filter((item) => !tracker.removed.has(item.sessionID) && !tracker.permission.has(item.id))
                pending.push(
                  ...Object.values(draft.permission)
                    .flat()
                    .filter((item) => !tracker.removed.has(item.sessionID) && tracker.permission.has(item.id)),
                )
                draft.permission = Object.groupBy(
                  [...new Map(pending.map((item) => [item.id, item])).values()],
                  (item) => item.sessionID,
                ) as Record<string, PermissionV2Request[]>
                const asked = [...snapshots, ...owned]
                  .flatMap((item) => item.questions)
                  .filter((item) => !tracker.removed.has(item.sessionID) && !tracker.question.has(item.id))
                asked.push(
                  ...Object.values(draft.question)
                    .flat()
                    .filter((item) => !tracker.removed.has(item.sessionID) && tracker.question.has(item.id)),
                )
                draft.question = Object.groupBy(
                  [...new Map(asked.map((item) => [item.id, item])).values()],
                  (item) => item.sessionID,
                ) as Record<string, QuestionV2Request[]>
              }),
            )
          })(),
          ...[...new Set([...Object.keys(store.session.message), ...hydrating.keys()])]
            .filter((id) => sdk.interest.includes(id))
            .map((id) => result.session.message.refresh(id)),
        ]).finally(() => {
          if (recovering === tracker) recovering = undefined
        })
      }),
    )

    onMount(() => {
      void Promise.allSettled([
        result.location.refresh(),
        result.location.agent.refresh(),
        result.location.integration.refresh(),
        result.location.model.refresh(),
        result.location.provider.refresh(),
        result.location.reference.refresh(),
        result.location.command.refresh(),
        result.location.skill.refresh(),
      ]).then((settled) => {
        for (const failure of settled.filter((item) => item.status === "rejected"))
          console.error("Failed to refresh default location data", failure.reason)
      })
    })

    return result
  },
})

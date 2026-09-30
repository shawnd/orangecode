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
      { events: { sequence: number; durable: boolean; event: V2Event }[]; task?: Promise<void> }
    >()
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
        event.type.startsWith("session.next.") &&
        "sessionID" in event.data &&
        typeof event.data.sessionID === "string" &&
        !sdk.interest.includes(event.data.sessionID)
      )
        return
      switch (event.type) {
        case "permission.v2.asked":
          setStore("session", "permission", event.data.sessionID, (items = []) => [
            ...items.filter((item) => item.id !== event.data.id),
            event.data,
          ])
          break
        case "permission.v2.replied":
          setStore("session", "permission", event.data.sessionID, (items = []) =>
            items.filter((item) => item.id !== event.data.requestID),
          )
          break
        case "question.v2.asked":
          setStore("session", "question", event.data.sessionID, (items = []) => [
            ...items.filter((item) => item.id !== event.data.id),
            event.data,
          ])
          break
        case "question.v2.replied":
        case "question.v2.rejected":
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
            }
          }),
        ),
      ),
    )

    onMount(() => {
      const unsub = events.subscribe((event, metadata) => {
        if (event.type === "server.connected" && sdk.selective) {
          for (const sessionID of Object.keys(store.session.message)) {
            void result.session.message
              .refresh(sessionID)
              .catch((error) => console.error("Failed to refresh Session messages", error))
          }
        }
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
          const result = await sdk.client.v2.session.get({ sessionID }, { throwOnError: true })
          setStore("session", "info", sessionID, result.data.data)
        },
        message: {
          list(sessionID: string) {
            return store.session.message[sessionID]
          },
          async refresh(sessionID: string) {
            await sdk.eventsReady()
            if (!sdk.interest.includes(sessionID)) return
            const current = hydrating.get(sessionID)
            if (current) return current.task
            const tracker: { events: { sequence: number; durable: boolean; event: V2Event }[]; task?: Promise<void> } =
              { events: [] }
            hydrating.set(sessionID, tracker)
            tracker.task = (async () => {
              const response = await sdk.client.v2.session.messages({ sessionID }, { throwOnError: true })
              sdk.flushEvents()
              if (!sdk.interest.includes(sessionID) || hydrating.get(sessionID) !== tracker) return
              if (sdk.selective && response.data.sequence === undefined) {
                throw new Error("Selective Session hydration requires a server snapshot sequence")
              }
              setStore("session", "message", sessionID, response.data.data)
              const sequence = response.data.sequence ?? -1
              sequences.set(sessionID, sequence)
              // Replay only commits newer than the atomic snapshot. Delayed older
              // stream events are rejected by the sequence floor above.
              for (const pending of tracker.events) {
                if (!pending.durable) {
                  if (pending.sequence >= sequence) handleEvent(pending.event)
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
            const result = await sdk.client.v2.session.permission.list({ sessionID }, { throwOnError: true })
            setStore("session", "permission", sessionID, result.data.data)
          },
        },
        question: {
          list(sessionID: string) {
            return store.session.question[sessionID]
          },
          async refresh(sessionID: string) {
            const result = await sdk.client.v2.session.question.list({ sessionID }, { throwOnError: true })
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

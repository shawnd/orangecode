import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"

import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(SessionNs.node), httpApiLayer))

const model = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test"),
}

afterEach(async () => {
  await disposeAllInstances()
})

const withoutWatcher = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  if (process.platform !== "win32") return effect
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
      process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
        else process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = previous
      }),
  )
}

const sessionScoped = Effect.acquireRelease(SessionNs.use.create({}), (session) =>
  SessionNs.use.remove(session.id).pipe(Effect.ignore),
)

const fill = Effect.fn("SessionMessagesTest.fill")(function* (
  sessionID: SessionID,
  count: number,
  time = (i: number) => Date.now() + i,
) {
  const session = yield* SessionNs.Service
  return yield* Effect.forEach(
    Array.from({ length: count }, (_, i) => i),
    (i) =>
      Effect.gen(function* () {
        const id = MessageID.ascending()
        yield* session.updateMessage({
          id,
          sessionID,
          role: "user",
          time: { created: time(i) },
          agent: "test",
          model,
          tools: {},
        } satisfies SessionV1.User)
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: `m${i}`,
        } satisfies SessionV1.TextPart)
        return id
      }),
  )
})

function request(path: string) {
  return TestInstance.pipe(Effect.flatMap((test) => requestInDirectory(path, test.directory)))
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((body) => body as T))
}

describe("session messages endpoint", () => {
  it.instance(
    "returns cursor headers for older pages",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 5)

        const a = yield* request(`/session/${session.id}/message?limit=2`)
        expect(a.status).toBe(200)
        const aBody = yield* json<SessionV1.WithParts[]>(a)
        expect(aBody.map((item) => item.info.id)).toEqual(ids.slice(-2))
        const cursor = a.headers["x-next-cursor"]
        expect(cursor).toBeTruthy()
        expect(a.headers["link"]).toContain('rel="next"')

        const b = yield* request(`/session/${session.id}/message?limit=2&before=${encodeURIComponent(cursor!)}`)
        expect(b.status).toBe(200)
        const bBody = yield* json<SessionV1.WithParts[]>(b)
        expect(bBody.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))
      }),
    ),
    { git: true },
  )

  it.instance(
    "keeps full-history responses when limit is omitted",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 3)

        const res = yield* request(`/session/${session.id}/message`)
        expect(res.status).toBe(200)
        const body = yield* json<SessionV1.WithParts[]>(res)
        expect(body.map((item) => item.info.id)).toEqual(ids)
      }),
    ),
    { git: true },
  )

  it.instance(
    "reconciles orphaned background shells through paginated and full-history responses",
    withoutWatcher(
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const session = yield* sessionScoped
        const [userID] = yield* fill(session.id, 1)
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          parentID: userID,
          role: "assistant",
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: session.directory, root: session.directory },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.modelID,
          providerID: model.providerID,
          time: { created: Date.now() },
        } satisfies SessionV1.Assistant)
        const part = {
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: assistant.id,
          callID: "orphaned-shell",
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "bun run build" },
            title: "Build",
            output: "Background shell started",
            metadata: { background: true, shellStatus: "running", jobId: "job_old", pid: process.pid, stdinOpen: true },
            time: { start: 1, end: 2 },
          },
        } satisfies SessionV1.ToolPart
        yield* sessions.updatePart(part)

        const paged = yield* request(`/session/${session.id}/message?limit=1`)
        expect(paged.status).toBe(200)
        const page = yield* json<SessionV1.WithParts[]>(paged)
        expect(page[0]?.parts[0]).toMatchObject({
          id: part.id,
          state: { metadata: { shellStatus: "cancelled", stdinOpen: false } },
        })
        expect(paged.headers["x-next-cursor"]).toBeTruthy()

        yield* sessions.updatePart(part)
        const full = yield* request(`/session/${session.id}/message`)
        expect(full.status).toBe(200)
        const history = yield* json<SessionV1.WithParts[]>(full)
        expect(history.find((item) => item.info.id === assistant.id)?.parts[0]).toMatchObject({
          id: part.id,
          state: { metadata: { shellStatus: "cancelled", stdinOpen: false } },
        })
      }),
    ),
    { git: true },
  )

  it.instance(
    "rejects invalid cursors and missing sessions",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped

        const bad = yield* request(`/session/${session.id}/message?limit=2&before=bad`)
        expect(bad.status).toBe(400)

        const miss = yield* request(`/session/ses_missing/message?limit=2`)
        expect(miss.status).toBe(404)
      }),
    ),
    { git: true },
  )

  it.instance(
    "does not truncate large legacy limit requests",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* fill(session.id, 520)

        const res = yield* request(`/session/${session.id}/message?limit=510`)
        expect(res.status).toBe(200)
        const body = yield* json<SessionV1.WithParts[]>(res)
        expect(body).toHaveLength(510)
      }),
    ),
    { git: true },
  )

  it.instance(
    "accepts directory query used by workspace routing",
    withoutWatcher(
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const session = yield* sessionScoped
        yield* fill(session.id, 1)

        const res = yield* request(
          `/session/${session.id}/message?limit=80&directory=${encodeURIComponent(tmp.directory)}`,
        )
        expect(res.status).toBe(200)
        const body = yield* json<unknown[]>(res)
        expect(Array.isArray(body)).toBe(true)
        expect(body).toHaveLength(1)
      }),
    ),
    { git: true },
  )
})

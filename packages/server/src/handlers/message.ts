import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { and, eq, placeholder } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerResponse } from "effect/unstable/http"
import { SessionMessagesResponse } from "@opencode-ai/protocol/groups/message"
import { Api } from "../api"
import { makeTranscriptPageCache } from "../transcript-page-cache"
import { InvalidCursorError, SessionNotFoundError, UnknownError } from "@opencode-ai/protocol/errors"

const DefaultMessagesLimit = 50
// HttpApiEndpoint transforms JSON success schemas through toCodecJson (notably
// optional undefined fields become null). Preserve that exact wire encoding.
const encodePage = Schema.encodeEffect(Schema.toCodecJson(SessionMessagesResponse))

const Cursor = Schema.Struct({
  id: SessionMessage.ID,
  order: Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")]),
  direction: Schema.Union([Schema.Literal("previous"), Schema.Literal("next")]),
})

const decodeCursor = Schema.decodeUnknownSync(Cursor)

const cursor = {
  encode(message: SessionMessage.Message, order: "asc" | "desc", direction: "previous" | "next") {
    return Buffer.from(JSON.stringify({ id: message.id, order, direction })).toString("base64url")
  },
  decode(input: string) {
    return decodeCursor(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
  },
}

export const MessageHandler = HttpApiBuilder.group(Api, "server.message", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const database = yield* Database.Service
    const cache = yield* makeTranscriptPageCache()
    const latestSequence = EventV2.prepareLatestSequence(database.db)
    const revisionQuery = database.db
      .select({ id: EventTable.id })
      .from(EventTable)
      .where(and(eq(EventTable.aggregate_id, placeholder("sessionID")), eq(EventTable.seq, placeholder("sequence"))))
      .prepare()

    return handlers.handle(
      "session.messages",
      Effect.fn(function* (ctx) {
        if (ctx.query.cursor && ctx.query.order !== undefined)
          return yield* new InvalidCursorError({ message: "Cursor cannot be combined with order" })
        const decoded = yield* Effect.try({
          try: () => (ctx.query.cursor ? cursor.decode(ctx.query.cursor) : undefined),
          catch: () => new InvalidCursorError({ message: "Invalid cursor" }),
        })
        const order = decoded?.order ?? ctx.query.order ?? "desc"
        const limit = ctx.query.limit ?? DefaultMessagesLimit
        return yield* database.db
          .transaction(() =>
            Effect.gen(function* () {
              const sequence = yield* latestSequence(ctx.params.sessionID)
              // Deletion removes aggregate history; an adopted/recreated ID can
              // reuse a sequence. Its immutable event ID separates incarnations.
              const revision =
                sequence < 0
                  ? undefined
                  : yield* revisionQuery.get({ sessionID: ctx.params.sessionID, sequence }).pipe(Effect.orDie)
              // Keep SessionStore's existence and Info validation on hits, inside
              // the same read snapshot. Authorization and Location acquisition
              // still run in the outer production middleware on every request.
              const info = yield* session.get(ctx.params.sessionID).pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
              )
              const key = JSON.stringify([
                "SessionMessagesResponse:json:v1",
                ctx.params.sessionID,
                sequence,
                revision?.id ?? null,
                info.location.directory,
                info.location.workspaceID ?? null,
                order,
                decoded?.id ?? null,
                decoded?.direction ?? "next",
                limit,
              ])
              // This endpoint has one SQL-backed view for all authorized callers;
              // any future per-user projection must also partition this key.
              const cached = cache.get(key, ctx.params.sessionID, sequence, revision?.id)
              if (cached !== undefined) return HttpServerResponse.text(cached, { contentType: "application/json" })
              const messages = yield* session
                .messages({
                  sessionID: ctx.params.sessionID,
                  limit,
                  order,
                  cursor: decoded ? { id: decoded.id, direction: decoded.direction } : undefined,
                })
                .pipe(
                  Effect.catchTag("Session.NotFoundError", (error) =>
                    Effect.fail(
                      new SessionNotFoundError({
                        sessionID: error.sessionID,
                        message: `Session not found: ${error.sessionID}`,
                      }),
                    ),
                  ),
                  Effect.catchTag("Session.MessageDecodeError", (error) => {
                    const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                    return Effect.logError("failed to decode session message").pipe(
                      Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                      Effect.andThen(
                        Effect.fail(
                          new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                        ),
                      ),
                    )
                  }),
                )
              const first = messages[0]
              const last = messages.at(-1)
              const page = {
                data: messages,
                sequence,
                cursor: {
                  previous: first ? cursor.encode(first, order, "previous") : undefined,
                  next: last ? cursor.encode(last, order, "next") : undefined,
                },
              }
              if (!revision) return page
              // Only successfully encoded canonical contract values are retained.
              // On encoding failure return the value to HttpApi's normal encoder
              // so its existing schema-error middleware owns the error response.
              const encoded = yield* encodePage(page).pipe(Effect.option)
              if (Option.isNone(encoded)) return page
              const body = yield* Effect.try({
                try: () => JSON.stringify(encoded.value),
                catch: (error) => error,
              }).pipe(Effect.option)
              if (Option.isNone(body)) return page
              cache.set(key, ctx.params.sessionID, sequence, body.value, revision.id)
              return HttpServerResponse.text(body.value, { contentType: "application/json" })
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die))
      }),
    )
  }),
)

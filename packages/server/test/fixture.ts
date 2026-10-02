import { Context, Effect, Layer, Option } from "effect"
import { HttpRouter } from "effect/unstable/http"
import type { HttpApiGroup } from "effect/unstable/httpapi"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { LocationServiceMap, buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { MessageGroup } from "@opencode-ai/protocol/groups/message"
import { MessageHandler } from "../src/handlers/message"
import { ServerAuth } from "../src/auth"
import { authorizationLayer } from "../src/middleware/authorization"
import { sessionLocationLayer, SessionLocationMiddleware } from "../src/middleware/session-location"
import { schemaErrorLayer, SchemaErrorMiddleware } from "../src/middleware/schema-error"
import { Authorization } from "../src/middleware/authorization"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const Routes = Context.Service<
  HttpApiGroup.ApiGroup<"server", "server.message">,
  { routes: ReadonlyArray<HttpRouter.Route<never, never>> }
>(MessageGroup.key)

// Real storage, Session implementation, event publication/projectors and outer
// middleware. Unused execution/project services fail if accidentally invoked.
export const fixture = Effect.fn("TranscriptTest.fixture")(function* (
  handler: typeof MessageHandler = MessageHandler,
  filename = ":memory:",
) {
  const counts = { reads: 0, placements: 0 }
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "transcript-cache-"))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
  yield* Effect.promise(() => mkdir(join(directory, "moved")))
  const auth = { username: "test", password: Option.some("private-fixture") }
  const database = Database.layerFromPath(filename)
  const events = EventV2.layerWith().pipe(Layer.provide(database))
  const locations = Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const original = yield* LocationServiceMap.Service
      return LocationServiceMap.Service.of({
        ...original,
        get: (ref) => {
          counts.placements++
          return original.get(ref)
        },
      })
    }),
  ).pipe(
    Layer.provide(
      buildLocationServiceMap([
        [Database.node, database],
        [EventV2.node, events],
      ]),
    ),
  )
  const sessions = LayerNode.compile(SessionV2.node, [
    [Database.node, database],
    [EventV2.node, events],
    [LocationServiceMap.node, locations],
    [ProjectV2.node, Layer.mock(ProjectV2.Service, {})],
    [SessionExecution.node, SessionExecution.noopLayer],
  ])
  const counted = Layer.effect(
    SessionV2.Service,
    Effect.gen(function* () {
      const original = yield* SessionV2.Service
      return SessionV2.Service.of({
        ...original,
        messages: (input) => {
          counts.reads++
          return original.messages(input)
        },
      })
    }),
  ).pipe(Layer.provide(sessions))
  const dependencies: Layer.Layer<
    Database.Service | EventV2.Service | SessionV2.Service | LocationServiceMap.Service,
    unknown
  > = Layer.mergeAll(
    database,
    events,
    counted,
    locations,
    LayerNode.compile(SessionProjector.node, [
      [Database.node, database],
      [EventV2.node, events],
    ]),
  )
  const middleware: Layer.Layer<SessionLocationMiddleware | SchemaErrorMiddleware | Authorization> = Layer.mergeAll(
    schemaErrorLayer,
    authorizationLayer.pipe(Layer.provide(Layer.succeed(ServerAuth.Config, auth))),
    sessionLocationLayer.pipe(Layer.provide(Layer.mergeAll(database, locations))),
  )
  const layers = Layer.mergeAll(dependencies, handler.pipe(Layer.provide(Layer.mergeAll(dependencies, middleware))))
  const context = yield* Layer.build(layers.pipe(Layer.fresh))
  const group = Context.get(context, Routes)
  const web = HttpRouter.toWebHandler(HttpRouter.addAll(group.routes), { disableLogger: true })
  yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))
  const db = Context.get(context, Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
    .onConflictDoNothing()
    .run()
  const seed = (id: string, placement = directory) =>
    db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make(id),
        project_id: Project.ID.global,
        directory: placement,
        slug: "fixture",
        title: "fixture",
        version: "test",
      })
      .run()
  const request = (
    id: string,
    query = "",
    authorization = `Basic ${Buffer.from("test:private-fixture").toString("base64")}`,
  ) =>
    Effect.promise(async () => {
      const response = await web.handler(
        new Request(`http://localhost/api/session/${id}/message${query}`, { headers: { authorization } }),
        Context.empty(),
      )
      return { status: response.status, headers: Object.fromEntries(response.headers), text: await response.text() }
    })
  return {
    db,
    events: Context.get(context, EventV2.Service),
    sessions: Context.get(context, SessionV2.Service),
    counts,
    auth,
    seed,
    request,
    web,
    directory,
  }
})

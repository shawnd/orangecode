import { expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer, Scope } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { Reference } from "@opencode-ai/core/reference"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.createRoutes(),
  { disableListenLog: true, disableLogger: true },
)
const it = testEffect(
  servedRoutes.pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(locationServiceMapLayer),
  ),
)

it.live("compatibility agents and V2 routes share the runtime location graph", () =>
  Effect.gen(function* () {
    const reference = yield* tmpdirScoped()
    const marker = yield* tmpdirScoped()
    const directory = yield* tmpdirScoped({
      git: true,
      config: { references: { docs: { path: reference } } },
    })
    const locations = yield* LocationServiceMap.Service
    const scope = yield* Scope.Scope
    const ref = Location.Ref.make({ directory: AbsolutePath.make(directory) })

    // A runtime-only reference cannot appear in a separately initialized map.
    // This also checks that standalone compatibility users share the HTTP map.
    yield* Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const references = yield* Reference.Service
      yield* plugins.wait(PluginV2.ID.make("core/config-reference"))
      yield* references
        .transform((draft) => draft.add("runtime-marker", { type: "local", path: AbsolutePath.make(marker) }))
        .pipe(Effect.provideService(Scope.Scope, scope))
    }).pipe(Effect.provide(locations.get(ref)))

    const agents = yield* HttpClientRequest.get("/agent").pipe(
      HttpClientRequest.setHeader("x-opencode-directory", directory),
      HttpClient.execute,
    )
    expect(agents.status).toBe(200)
    expect(yield* agents.json).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "build",
          permission: expect.arrayContaining([
            { permission: "external_directory", pattern: `${marker}/*`, action: "allow" },
          ]),
        }),
      ]),
    )

    const references = yield* HttpClientRequest.get("/api/reference").pipe(
      HttpClientRequest.setHeader("x-opencode-directory", directory),
      HttpClient.execute,
    )
    expect(references.status).toBe(200)
    const local = yield* Reference.Service.use((references) => references.list()).pipe(
      Effect.provide(locations.get(ref)),
    )
    expect(local.map((reference) => reference.name)).toContain("runtime-marker")
    expect(yield* references.json).toMatchObject({
      data: expect.arrayContaining([{ name: "runtime-marker", path: marker, source: { type: "local", path: marker } }]),
    })
  }),
)

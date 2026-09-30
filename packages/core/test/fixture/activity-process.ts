import { Effect } from "effect"
import { LayerNode } from "../../src/effect/layer-node"
import { Global } from "../../src/global"
import { SessionActivity } from "../../src/session/activity"
import { SessionSchema } from "../../src/session/schema"

await Effect.gen(function* () {
  const activity = yield* SessionActivity.Service
  yield* activity.set(SessionSchema.ID.make(process.argv[3]), { type: "busy" })
  process.stdout.write("ready\n")
  yield* Effect.never
}).pipe(
  Effect.provide(
    LayerNode.compile(SessionActivity.node, [[Global.node, Global.layerWith({ state: process.argv[2] })]]),
  ),
  Effect.runPromise,
)

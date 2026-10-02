import { createInterface } from "node:readline"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Effect, Layer, Ref, Schema } from "effect"
import { Config } from "../../src/config/config"
import { InstanceRef } from "../../src/effect/instance-ref"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { provideInstance } from "./fixture"
import { pollWithTimeout } from "../lib/effect"

const Command = Schema.Struct({
  id: Schema.String,
  op: Schema.Literals(["warm", "ask", "global", "once", "always", "pending"]),
  session: Schema.String,
  patterns: Schema.Array(Schema.String),
  permission: Schema.String,
  deny: Schema.Boolean,
  ruleset: Schema.optional(PermissionV1.Ruleset),
  requestID: Schema.optional(PermissionV1.ID),
})

const layer = AppNodeBuilder.build(
  LayerNode.group([Permission.node, Config.node, InstanceStore.node, EventV2Bridge.node]),
  [[InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })]],
)

await Effect.gen(function* () {
  const permission = yield* Permission.Service
  const config = yield* Config.Service
  const instance = yield* InstanceRef
  if (!instance) throw new Error("Missing worker instance")
  const checks = new Map<PermissionV1.ID, Ref.Ref<string | undefined>>()
  const asked: Array<Schema.Schema.Type<typeof Permission.Event.Asked>> = []
  const replied: Array<Schema.Schema.Type<typeof Permission.Event.Replied>> = []
  const events = yield* EventV2Bridge.Service
  const unsubscribe = yield* events.listen((event) =>
    Effect.sync(() => {
      if (event.type === Permission.Event.Asked.type)
        asked.push(Schema.decodeUnknownSync(Permission.Event.Asked)(event))
      if (event.type === Permission.Event.Replied.type)
        replied.push(Schema.decodeUnknownSync(Permission.Event.Replied)(event))
    }),
  )
  yield* Effect.addFinalizer(() => unsubscribe)
  const lines = createInterface({ input: process.stdin })
  yield* Effect.addFinalizer(() => Effect.sync(() => lines.close()))
  const iterator = lines[Symbol.asyncIterator]()

  while (true) {
    const line = yield* Effect.promise(() => iterator.next())
    if (line.done) {
      process.disconnect?.()
      return
    }
    const command = Schema.decodeUnknownSync(Schema.fromJsonString(Command))(line.value)
    const id = command.requestID ?? PermissionV1.ID.ascending()
    const result = yield* Effect.gen(function* () {
      if (command.op === "warm") {
        yield* config.getGlobal()
        return "ready"
      }
      if (command.op === "pending") {
        const completed = checks.get(id)
        if (!completed) throw new Error(`No permission check for ${id}`)
        return (yield* Ref.get(completed)) ?? "pending"
      }
      if (command.op === "global" || command.op === "once" || command.op === "always") {
        const completed = checks.get(id)
        if (!completed) throw new Error(`No permission check for ${id}`)
        yield* permission.reply({ requestID: id, reply: command.op })
        const result = yield* pollWithTimeout(
          Ref.get(completed),
          `Reply ${command.op} did not complete permission check ${id}`,
          "3 seconds",
        )
        if (result !== "allowed") throw new Error(`Reply ${command.op} completed ${id} with ${result}`)
        return "saved"
      }

      const completed = yield* Ref.make<string | undefined>(undefined)
      checks.set(id, completed)
      const ruleset: PermissionV1.Ruleset = command.ruleset ?? [
        { permission: command.permission, pattern: "*", action: command.deny ? "deny" : "ask" },
      ]
      yield* permission
        .ask({
          id,
          sessionID: SessionID.make(command.session),
          permission: command.permission,
          patterns: command.patterns,
          always: command.patterns,
          metadata: {},
          ruleset,
        })
        .pipe(
          Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "allowed" }),
          Effect.catchCause((cause) => Effect.succeed(`error: ${Cause.pretty(cause)}`)),
          Effect.flatMap((result) => Ref.set(completed, result)),
          Effect.forkScoped,
        )
      return yield* pollWithTimeout(
        Effect.gen(function* () {
          const result = yield* Ref.get(completed)
          if (result) return result
          if ((yield* permission.list()).some((request) => request.id === id)) return "pending"
          return undefined
        }),
        "permission check neither completed nor requested approval",
        "3 seconds",
      )
    })
    if (!process.send) throw new Error("Worker requires IPC")
    process.send({
      id: command.id,
      result,
      requestID: id,
      projectID: instance.project.id,
      pending: yield* permission.list(),
      asked,
      replied,
    })
  }
}).pipe(provideInstance(process.argv[2]), Effect.scoped, Effect.provide(layer), Effect.runPromise)

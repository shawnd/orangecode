import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Effect, Layer, Context, Schedule } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"

export const Event = PermissionV1.Event

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
  readonly status: () => Effect.Effect<PermissionV1.Status>
}

export type AskInput = PermissionV1.AskInput & { denials?: PermissionV1.Ruleset[] }

interface PendingEntry {
  info: PermissionV1.Request
  ruleset: PermissionV1.Ruleset
  denials: PermissionV1.Ruleset[]
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export function denied(permission: string, pattern: string, denials: PermissionV1.Ruleset[]) {
  return denials.find((ruleset) => evaluate(permission, pattern, ruleset).action === "deny")
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const refreshGlobal = Effect.fn("Permission.refreshGlobal")(function* (current: State) {
      if (!Array.from(current.pending.values()).some((item) => item.info.permission === "external_directory")) return
      const folder = (yield* config.getGlobal()).permission?.external_directory
      if (!folder) return
      const global = fromConfig({ external_directory: folder })
      for (const [id, item] of current.pending) {
        if (item.info.permission !== "external_directory") continue
        if (
          !item.info.patterns.every(
            (pattern) =>
              evaluate(item.info.permission, pattern, item.ruleset).action !== "deny" &&
              !denied(item.info.permission, pattern, item.denials) &&
              evaluate(item.info.permission, pattern, item.ruleset, global, current.approved).action === "allow",
          )
        )
          continue
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            // A manual reply may have settled this request while config was loading.
            if (!current.pending.delete(id)) return
            yield* events
              .publish(Event.Replied, {
                sessionID: item.info.sessionID,
                requestID: id,
                reply: "global",
              })
              .pipe(Effect.ensuring(Deferred.succeed(item.deferred, undefined)))
          }),
        )
      }
    })
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        // Waiting tools must resume even when no new permission check occurs locally.
        yield* refreshGlobal(state).pipe(
          Effect.catchCause((cause) => Effect.logError("failed to refresh global permissions", { cause })),
          Effect.repeat(Schedule.spaced("250 millis")),
          Effect.forkScoped,
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: AskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, denials = [], ...request } = input
      const folder =
        request.permission === "external_directory"
          ? (yield* config.getGlobal()).permission?.external_directory
          : undefined
      const global = folder ? fromConfig({ external_directory: folder }) : []
      let needsAsk = false

      for (const pattern of request.patterns) {
        const ceiling = denied(request.permission, pattern, denials)
        if (ceiling) {
          return yield* new PermissionV1.DeniedError({
            ruleset: ceiling.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        const configured = evaluate(request.permission, pattern, ruleset)
        const rule =
          configured.action === "deny" ? configured : evaluate(request.permission, pattern, ruleset, global, approved)
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      if (!needsAsk) return

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }
      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      pending.set(id, { info, ruleset, denials, deferred })
      yield* events.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const current = yield* InstanceState.get(state)
      const { approved, pending } = current
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      if (input.reply === "global") {
        if (existing.info.permission !== "external_directory" || !existing.info.always.length)
          return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })
        yield* config.updateGlobal({
          permission: {
            external_directory: Object.fromEntries(existing.info.always.map((pattern) => [pattern, "allow" as const])),
          },
        })
      }

      if (!pending.delete(input.requestID)) return
      // Claim the whole rejection batch before event publication can yield to the global poller.
      const rejected =
        input.reply === "reject"
          ? Array.from(pending.values()).filter((item) => item.info.sessionID === existing.info.sessionID)
          : []
      for (const item of rejected) pending.delete(item.info.id)
      if (input.reply === "reject") {
        return yield* Effect.forEach(
          [existing, ...rejected],
          (item) =>
            events.publish(Event.Replied, {
              sessionID: item.info.sessionID,
              requestID: item.info.id,
              reply: "reject",
            }),
          { discard: true },
        ).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              // Claimed requests are no longer available to instance cleanup if publication fails or is interrupted.
              yield* Deferred.fail(
                existing.deferred,
                input.message
                  ? new PermissionV1.CorrectedError({ feedback: input.message })
                  : new PermissionV1.RejectedError(),
              )
              for (const item of rejected) yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }),
          ),
        )
      }

      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })
      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return
      if (input.reply === "global") return yield* refreshGlobal(current)

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: input.reply,
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    const status = Effect.fn("Permission.status")(function* () {
      const global = yield* config.getGlobal()
      const configured = yield* config.get()
      const current = yield* InstanceState.get(state)
      return {
        global: fromConfig(global.permission ?? {}),
        configured: fromConfig(configured.permission ?? {}),
        approved: current.approved.map((rule) => ({ ...rule })),
        pending: Array.from(current.pending.values(), (item) => item.info),
      }
    })

    return Service.of({ ask, reply, list, status })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(
  tools: string[],
  ruleset: PermissionV1.Ruleset,
  denials: PermissionV1.Ruleset[] = [],
): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      return [ruleset, ...denials].some((rules) => {
        const rule = rules.findLast((rule) => Wildcard.match(permission, rule.permission))
        return rule?.pattern === "*" && rule.action === "deny"
      })
    }),
  )
}

export function visibleTools<T>(
  tools: Record<string, T>,
  ruleset: PermissionV1.Ruleset,
  denials: PermissionV1.Ruleset[] = [],
): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset, denials)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, Config.node] })

export * as Permission from "."

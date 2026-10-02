import { expect } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Effect, Exit, Fiber, Schema } from "effect"
import { applyEdits, modify } from "jsonc-parser"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(CrossSpawnSpawner.node))
const Response = Schema.Struct({
  id: Schema.String,
  result: Schema.String,
  requestID: PermissionV1.ID,
  projectID: Schema.String,
  pending: Schema.Array(PermissionV1.Request),
  asked: Schema.Array(PermissionV1.Event.Asked),
  replied: Schema.Array(PermissionV1.Event.Replied),
})
type Response = typeof Response.Type

const worker = (root: string, project: string) =>
  Effect.gen(function* () {
    const waiting = new Map<string, { resolve: (result: Response) => void; reject: (error: Error) => void }>()
    const status = { stderr: "", failure: undefined as Error | undefined }
    const fail = (error: Error) => {
      status.failure = error
      waiting.forEach((command) => command.reject(error))
      waiting.clear()
    }
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.spawn([process.execPath, path.join(import.meta.dir, "../fixture/permission-process.ts"), project], {
          cwd: project,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: path.join(root, "config"),
            XDG_DATA_HOME: path.join(root, "data"),
            XDG_STATE_HOME: path.join(root, "state"),
            XDG_CACHE_HOME: path.join(root, "cache"),
            OPENCODE_TEST_HOME: path.join(root, "home"),
            OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
            OPENCODE_DB: ":memory:",
            OPENCODE_DISABLE_PROJECT_CONFIG: "true",
            OPENCODE_CONFIG: "",
            OPENCODE_CONFIG_DIR: "",
            OPENCODE_CONFIG_CONTENT: "",
          },
          stdin: "pipe",
          stdout: "ignore",
          stderr: "pipe",
          ipc(message) {
            const response = Schema.decodeUnknownOption(Response)(message)
            if (response._tag === "None") {
              fail(new Error(`Invalid permission worker response: ${JSON.stringify(message)}`))
              return
            }
            waiting.get(response.value.id)?.resolve(response.value)
            waiting.delete(response.value.id)
          },
        }),
      ),
      (child) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: async () => {
              await child.stdin.end()
            },
            catch: (error) => error,
          }).pipe(Effect.timeout("1 second"), Effect.ignore)
          yield* Effect.promise(() => child.exited).pipe(
            Effect.timeoutOrElse({
              duration: "2 seconds",
              orElse: () =>
                Effect.gen(function* () {
                  child.kill("SIGTERM")
                  yield* Effect.promise(() => child.exited).pipe(
                    Effect.timeoutOrElse({
                      duration: "1 second",
                      orElse: () =>
                        Effect.gen(function* () {
                          child.kill("SIGKILL")
                          yield* Effect.promise(() => child.exited).pipe(
                            Effect.timeoutOrElse({
                              duration: "2 seconds",
                              orElse: () => Effect.fail(new Error(`Permission worker ${child.pid} did not exit`)),
                            }),
                          )
                        }),
                    }),
                  )
                }),
            }),
          )
        }).pipe(Effect.orDie),
    )
    const stderr = yield* Effect.promise(async () => {
      const decoder = new TextDecoder()
      const reader = child.stderr.getReader()
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) return
        status.stderr = (status.stderr + decoder.decode(chunk.value, { stream: true })).slice(-16000)
      }
    }).pipe(Effect.forkScoped)
    yield* Effect.gen(function* () {
      const code = yield* Effect.promise(() => child.exited)
      yield* Fiber.join(stderr)
      fail(new Error(`Permission worker exited with code ${code}, signal ${child.signalCode}`))
    }).pipe(Effect.forkScoped)

    const command = (
      op: "warm" | "ask" | "global" | "once" | "always" | "pending",
      input: {
        session?: string
        patterns?: string[]
        permission?: string
        deny?: boolean
        ruleset?: PermissionV1.Ruleset
        requestID?: PermissionV1.ID
      } = {},
    ) =>
      Effect.gen(function* () {
        const id = crypto.randomUUID()
        return yield* Effect.tryPromise({
          try: (signal) => {
            const abort = () => waiting.get(id)?.reject(new Error("Command interrupted"))
            signal.addEventListener("abort", abort, { once: true })
            return new Promise<Response>((resolve, reject) => {
              if (status.failure) return reject(status.failure)
              waiting.set(id, { resolve, reject })
              child.stdin.write(
                JSON.stringify({
                  id,
                  op,
                  session: "session_old",
                  patterns: ["/shared/*"],
                  permission: "external_directory",
                  deny: false,
                  ...input,
                }) + "\n",
              )
              Promise.resolve(child.stdin.flush()).catch(reject)
            }).finally(() => {
              signal.removeEventListener("abort", abort)
              waiting.delete(id)
            })
          },
          catch: (error) => new Error(String(error)),
        }).pipe(
          Effect.timeoutOrElse({
            duration: "8 seconds",
            orElse: () => Effect.fail(new Error("Timed out waiting for response")),
          }),
          Effect.mapError(
            (error) =>
              new Error(
                `Permission worker ${child.pid} (${project}), ${op} ${JSON.stringify(input)}: ${error.message}\n${status.stderr}`,
              ),
          ),
        )
      })
    return { command }
  })

const completed = (process: Effect.Success<ReturnType<typeof worker>>, request: Response, reply: PermissionV1.Reply) =>
  Effect.gen(function* () {
    const response = yield* pollWithTimeout(
      process
        .command("pending", { requestID: request.requestID })
        .pipe(Effect.map((response) => (response.result === "pending" ? undefined : response))),
      `Permission request ${request.requestID} did not complete`,
    )
    expect(response.result).toBe("allowed")
    expect(response.pending.map((request) => request.id)).not.toContain(request.requestID)
    const asked = response.asked.filter((event) => event.data.id === request.requestID)
    const replied = response.replied.filter((event) => event.data.requestID === request.requestID)
    expect(asked).toHaveLength(1)
    expect(replied.map((event) => event.data)).toEqual([
      {
        requestID: request.requestID,
        sessionID: asked[0].data.sessionID,
        reply,
      },
    ])
    expect(replied[0].location).toEqual(asked[0].location)
    return response
  })

const fixture = (sameProject = false) =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const olderProject = yield* tmpdirScoped({ git: true })
    const grantingProject = sameProject ? olderProject : yield* tmpdirScoped({ git: true })
    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(root, "config/opencode"), { recursive: true })
      await fs.mkdir(path.join(root, "cache/opencode"), { recursive: true })
      await fs.mkdir(path.join(root, "home"))
      await fs.mkdir(path.join(root, "managed"))
      await Bun.write(path.join(root, "cache/opencode/version"), "14")
      await Bun.write(
        path.join(root, "config/opencode/opencode.jsonc"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          username: "permission-sync-test",
          permission: { bash: "deny", external_directory: { "/existing/*": "allow" } },
        }),
      )
    })
    const older = yield* worker(root, olderProject)
    expect((yield* older.command("warm")).result).toBe("ready")
    const warmup = yield* older.command("ask", { patterns: ["/warmup/*"] })
    expect(warmup.result).toBe("pending")
    expect((yield* older.command("once", { requestID: warmup.requestID })).result).toBe("saved")
    yield* completed(older, warmup, "once")
    const granting = yield* worker(root, grantingProject)
    const grant = yield* granting.command("ask", { session: "session_granting" })
    expect(grant.result).toBe("pending")
    if (sameProject) expect(grant.projectID).toBe(warmup.projectID)
    if (!sameProject) expect(grant.projectID).not.toBe(warmup.projectID)
    return { root, olderProject, grantingProject, older, granting, grant }
  })

it.live(
  "a global approval reaches old and new sessions in another existing process and project",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      expect((yield* test.granting.command("global", { requestID: test.grant.requestID })).result).toBe("saved")
      yield* completed(test.granting, test.grant, "global")
      for (const session of ["session_old", "session_new"]) {
        const response = yield* test.older.command("ask", { session })
        expect(response.result).toBe("allowed")
        expect(response.pending).toEqual([])
        expect(response.asked.filter((event) => event.data.id === response.requestID)).toEqual([])
        expect(response.replied.filter((event) => event.data.requestID === response.requestID)).toEqual([])
      }
    }),
  30000,
)

for (const sameProject of [false, true]) {
  it.live(
    `a global approval completes pending requests in an existing ${sameProject ? "same" : "cross"}-project process exactly once`,
    () =>
      Effect.gen(function* () {
        const test = yield* fixture(sameProject)
        const matching = yield* test.older.command("ask")
        const another = yield* test.older.command("ask", { session: "session_another" })
        expect(matching.result).toBe("pending")
        expect(another.result).toBe("pending")
        expect((yield* test.granting.command("global", { requestID: test.grant.requestID })).result).toBe("saved")
        yield* completed(test.granting, test.grant, "global")
        yield* completed(test.older, matching, "global")
        yield* completed(test.older, another, "global")
        // A later save exercises another refresh without replying to settled requests again.
        const next = yield* test.granting.command("ask", { patterns: ["/second/*"] })
        expect(next.result).toBe("pending")
        yield* test.granting.command("global", { requestID: next.requestID })
        const second = yield* test.older.command("ask", { patterns: ["/second/*"] })
        expect(second.result).toBe("allowed")
        yield* completed(test.older, matching, "global")
        yield* completed(test.older, another, "global")
      }),
    30000,
  )
}

it.live(
  "a global reply completes another pending session in the same instance",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const one = yield* test.older.command("ask")
      const two = yield* test.older.command("ask", { session: "session_other" })
      expect(one.result).toBe("pending")
      expect(two.result).toBe("pending")
      yield* test.older.command("global", { requestID: one.requestID })
      yield* completed(test.older, one, "global")
      yield* completed(test.older, two, "global")
    }),
  30000,
)

it.live(
  "a fresh process honors the persisted global approval",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      yield* test.granting.command("global", { requestID: test.grant.requestID })
      const fresh = yield* worker(test.root, test.olderProject)
      expect((yield* fresh.command("ask")).result).toBe("allowed")
    }),
  30000,
)

it.live(
  "a global approval leaves unrelated, partially matching, and other-permission requests pending",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const matching = yield* test.older.command("ask")
      const unrelated = yield* test.older.command("ask", { session: "session_unrelated", patterns: ["/unrelated/*"] })
      const partial = yield* test.older.command("ask", {
        session: "session_partial",
        patterns: ["/shared/*", "/unrelated/*"],
      })
      const other = yield* test.older.command("ask", { session: "session_other", permission: "read" })
      for (const request of [matching, unrelated, partial, other]) expect(request.result).toBe("pending")
      yield* test.granting.command("global", { requestID: test.grant.requestID })
      yield* completed(test.older, matching, "global")
      for (const request of [unrelated, partial, other]) {
        const response = yield* test.older.command("pending", { requestID: request.requestID })
        expect(response.result).toBe("pending")
        expect(response.pending.map((request) => request.id).sort()).toEqual(
          [unrelated, partial, other].map((request) => request.requestID).sort(),
        )
        expect(response.replied.filter((event) => event.data.requestID === request.requestID)).toEqual([])
      }
    }),
  30000,
)

for (const source of ["captured rules", "instance approval"]) {
  it.live(
    `a remote global approval combines with ${source} to complete only fully allowed multi-pattern requests`,
    () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const ruleset: PermissionV1.Ruleset =
          source === "captured rules"
            ? [
                { permission: "external_directory", pattern: "*", action: "ask" },
                { permission: "external_directory", pattern: "/local/*", action: "allow" },
              ]
            : [{ permission: "external_directory", pattern: "*", action: "ask" }]
        if (source === "instance approval") {
          const local = yield* test.older.command("ask", { patterns: ["/local/*"] })
          expect(local.result).toBe("pending")
          yield* test.older.command("always", { requestID: local.requestID })
          yield* completed(test.older, local, "always")
        }
        expect((yield* test.older.command("ask", { patterns: ["/local/*"], ruleset })).result).toBe("allowed")
        const matching = yield* test.older.command("ask", { patterns: ["/local/*", "/shared/*"], ruleset })
        const partial = yield* test.older.command("ask", {
          session: "session_partial",
          patterns: ["/local/*", "/shared/*", "/unmatched/*"],
          ruleset,
        })
        expect(matching.result).toBe("pending")
        expect(partial.result).toBe("pending")
        yield* test.granting.command("global", { requestID: test.grant.requestID })
        yield* completed(test.granting, test.grant, "global")
        yield* completed(test.older, matching, "global")
        const pending = yield* test.older.command("pending", { requestID: partial.requestID })
        expect(pending.result).toBe("pending")
        expect(pending.pending.map((request) => request.id)).toEqual([partial.requestID])
        expect(pending.pending[0].patterns).toEqual(["/local/*", "/shared/*", "/unmatched/*"])
        expect(pending.replied.filter((event) => event.data.requestID === partial.requestID)).toEqual([])
      }),
    30000,
  )
}

it.live(
  "a one-time approval completes only its request, including within the same process",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture(true)
      const remote = yield* test.older.command("ask")
      const local = yield* test.granting.command("ask", { session: "session_local" })
      expect(remote.result).toBe("pending")
      expect(local.result).toBe("pending")
      yield* test.granting.command("once", { requestID: test.grant.requestID })
      yield* completed(test.granting, test.grant, "once")
      for (const [process, request] of [
        [test.older, remote],
        [test.granting, local],
      ] as const) {
        const response = yield* process.command("pending", { requestID: request.requestID })
        expect(response.result).toBe("pending")
        expect(response.pending.map((request) => request.id)).toContain(request.requestID)
        expect(response.replied.filter((event) => event.data.requestID === request.requestID)).toEqual([])
      }
      expect((yield* test.granting.command("ask", { session: "session_granting" })).result).toBe("pending")
      const fresh = yield* worker(test.root, test.olderProject)
      expect((yield* fresh.command("ask")).result).toBe("pending")
    }),
  30000,
)

it.live(
  "a global approval does not override an explicit deny in an existing session",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      yield* test.granting.command("global", { requestID: test.grant.requestID })
      const denied = yield* test.older.command("ask", { deny: true })
      expect(denied.result).toBe("PermissionDeniedError")
      expect(denied.pending).toEqual([])
      expect(denied.asked.filter((event) => event.data.id === denied.requestID)).toEqual([])
      expect(denied.replied.filter((event) => event.data.requestID === denied.requestID)).toEqual([])
    }),
  30000,
)

it.live(
  "concurrent global saves preserve both grants and existing configuration",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const second = yield* worker(test.root, test.grantingProject)
      const secondGrant = yield* second.command("ask", { patterns: ["/second/*"] })
      const firstPending = yield* test.older.command("ask")
      const secondPending = yield* test.older.command("ask", { session: "session_second", patterns: ["/second/*"] })
      expect(secondGrant.result).toBe("pending")
      expect(firstPending.result).toBe("pending")
      expect(secondPending.result).toBe("pending")
      const results = yield* Effect.all(
        [
          test.granting.command("global", { requestID: test.grant.requestID }),
          second.command("global", { requestID: secondGrant.requestID }),
        ],
        { concurrency: "unbounded" },
      )
      expect(results.map((response) => response.result)).toEqual(["saved", "saved"])
      yield* completed(test.granting, test.grant, "global")
      yield* completed(second, secondGrant, "global")
      yield* completed(test.older, firstPending, "global")
      yield* completed(test.older, secondPending, "global")
      expect(
        yield* Effect.promise(() => Bun.file(path.join(test.root, "config/opencode/opencode.jsonc")).json()),
      ).toEqual({
        $schema: "https://opencode.ai/config.json",
        username: "permission-sync-test",
        permission: {
          bash: "deny",
          external_directory: { "/existing/*": "allow", "/shared/*": "allow", "/second/*": "allow" },
        },
      })
      const fresh = yield* worker(test.root, test.olderProject)
      for (const pattern of ["/shared/*", "/second/*", "/existing/*"]) {
        expect((yield* fresh.command("ask", { patterns: [pattern] })).result).toBe("allowed")
      }
    }),
  30000,
)

it.live(
  "a failed permission worker reports the command, exit code, and stderr instead of timing out",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const requestID = PermissionV1.ID.make("per_missing")
      const exit = yield* test.older.command("pending", { requestID }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toContain(test.olderProject)
      expect(String(error)).toContain(`pending ${JSON.stringify({ requestID })}`)
      expect(String(error)).toContain("exited with code 1")
      expect(String(error)).toContain(`No permission check for ${requestID}`)
      expect(String(error)).not.toContain("Timed out waiting")
      const subsequent = yield* test.older.command("warm").pipe(Effect.exit)
      expect(Exit.isFailure(subsequent)).toBe(true)
      if (Exit.isFailure(subsequent)) expect(String(Cause.squash(subsequent.cause))).toContain("exited with code 1")
    }),
  30000,
)

it.live(
  "revoking a global grant removes it from both the granting and observing processes",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const pending = yield* test.older.command("ask")
      expect(pending.result).toBe("pending")
      yield* test.granting.command("global", { requestID: test.grant.requestID })
      yield* completed(test.granting, test.grant, "global")
      yield* completed(test.older, pending, "global")
      const file = path.join(test.root, "config/opencode/opencode.jsonc")
      const text = yield* Effect.promise(() => Bun.file(file).text())
      yield* Effect.promise(() =>
        Bun.write(
          file,
          applyEdits(text, modify(text, ["permission", "external_directory", "/shared/*"], undefined, {})),
        ),
      )

      for (const process of [test.granting, test.older]) {
        const response = yield* process.command("ask")
        expect(response.result).toBe("pending")
        expect(response.pending.map((request) => request.id)).toContain(response.requestID)
        expect(response.replied.filter((event) => event.data.requestID === response.requestID)).toEqual([])
        expect((yield* process.command("ask", { patterns: ["/existing/*"] })).result).toBe("allowed")
      }
    }),
  30000,
)

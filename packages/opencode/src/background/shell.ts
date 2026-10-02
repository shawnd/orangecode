import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Queue, Scope, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Identifier } from "@opencode-ai/core/id/id"
import { Shell } from "@opencode-ai/core/shell"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { archivedOutput, type OutputAvailability } from "@opencode-ai/core/background-job"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "./job"
import { Truncate } from "@/tool/truncate"

export type Info = OutputAvailability & {
  id: string
  sessionID: string
  command: string
  cwd: string
  status: BackgroundJob.Status
  startedAt: number
  completedAt?: number
  pid?: number
  exit?: number
  error?: string
  stdinOpen: boolean
  output: string
  outputPath: string
  stdoutPath: string
  stderrPath: string
}

export type StartInput = {
  sessionID: string
  ancestors: string[]
  shell: string
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  timeout?: number
  stdin?: boolean
  onUpdate?: (info: Info) => Effect.Effect<boolean>
  onComplete?: (info: Info) => Effect.Effect<void>
}

type Entry = {
  info: Info
  ancestors: string[]
  stdin?: Queue.Queue<Uint8Array, Cause.Done>
  dirty?: Queue.Queue<void>
  tailPath?: string
  tailExpiresAt?: number
  revision: number
}

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<Info, Error>
  readonly list: (sessionID: string) => Effect.Effect<Info[]>
  readonly get: (sessionID: string, id: string) => Effect.Effect<Info, Error>
  readonly input: (sessionID: string, id: string, text: string, eof?: boolean) => Effect.Effect<Info, Error>
  readonly cancel: (sessionID: string, id: string) => Effect.Effect<Info, Error>
  readonly output: (input: {
    sessionID: string
    id: string
    stream?: "all" | "stdout" | "stderr"
    query?: string
    offset?: number
    limit?: number
    wait?: number
  }) => Effect.Effect<
    { info: Info; path: string; lines: { line: number; text: string }[]; more: boolean; nextOffset: number },
    Error
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BackgroundShell") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    const fs = yield* FSUtil.Service
    const spawner = yield* ChildProcessSpawner
    const trunc = yield* Truncate.Service
    const flags = yield* RuntimeFlags.Service
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        return { entries: new Map<string, Entry>(), scope: yield* Scope.Scope }
      }),
    )

    const requireEntry = Effect.fn("BackgroundShell.requireEntry")(function* (sessionID: string, id: string) {
      const data = yield* InstanceState.get(state)
      const entry = data.entries.get(id)
      if (!entry || (entry.info.sessionID !== sessionID && !entry.ancestors.includes(sessionID))) {
        return yield* Effect.fail(new Error(`No shell job ${id} belongs to this session`))
      }
      return entry
    })

    const snapshot = Effect.fnUntraced(function* (entry: Entry) {
      if (!entry.tailPath) return { ...entry.info }
      const output = yield* archivedOutput({
        load: fs
          .readFileString(entry.tailPath)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined))),
        expiresAt: entry.tailExpiresAt,
      })
      return {
        ...entry.info,
        ...output,
        output: "output" in output ? (output.output ?? "") : "",
      }
    })

    const start: Interface["start"] = Effect.fn("BackgroundShell.start")(function* (input) {
      const data = yield* InstanceState.get(state)
      const outputPath = yield* trunc.write("")
      const entry: Entry = {
        info: {
          id: Identifier.ascending("job"),
          sessionID: input.sessionID,
          command: input.command,
          cwd: input.cwd,
          status: "running",
          startedAt: yield* Clock.currentTimeMillis,
          stdinOpen: input.stdin === true,
          output: "",
          outputPath,
          stdoutPath: `${outputPath}.stdout.log`,
          stderrPath: `${outputPath}.stderr.log`,
        },
        ancestors: input.ancestors,
        stdin: yield* Queue.bounded<Uint8Array, Cause.Done>(16),
        dirty: yield* Queue.sliding<void>(1),
        revision: 0,
      }
      yield* Effect.all([
        fs.writeFileString(entry.info.stdoutPath, ""),
        fs.writeFileString(entry.info.stderrPath, ""),
      ]).pipe(Effect.mapError(error))
      const ready = yield* Deferred.make<void, Error>()
      const projected = yield* Deferred.make<void>()
      const delivered = yield* Deferred.make<void>()
      const stdin = entry.stdin
      const dirty = entry.dirty
      if (!stdin || !dirty) return yield* Effect.die(new Error("Missing shell queues"))
      const run = Effect.scoped(
        Effect.gen(function* () {
          const logs = {
            all: yield* fs.open(entry.info.outputPath, { flag: "a" }),
            stdout: yield* fs.open(entry.info.stdoutPath, { flag: "a" }),
            stderr: yield* fs.open(entry.info.stderrPath, { flag: "a" }),
          }
          const options = {
            cwd: input.cwd,
            env: input.env,
            stdin: input.stdin ? Stream.fromQueue(stdin) : ("ignore" as const),
            detached: process.platform !== "win32",
            forceKillAfter: "3 seconds" as const,
          }
          const command =
            process.platform === "win32" && Shell.ps(input.shell)
              ? ChildProcess.make(
                  input.shell,
                  ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", input.command],
                  options,
                )
              : ChildProcess.make(input.command, [], { ...options, shell: input.shell })
          const handle = yield* spawner.spawn(command)
          entry.info.pid = handle.pid
          yield* Queue.offer(dirty, undefined)
          const output = yield* Stream.merge(
            Stream.decodeText(handle.stdout).pipe(Stream.map((text) => ({ stream: "stdout" as const, text }))),
            Stream.decodeText(handle.stderr).pipe(Stream.map((text) => ({ stream: "stderr" as const, text }))),
          ).pipe(
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                const bytes = new TextEncoder().encode(chunk.text)
                yield* logs[chunk.stream].writeAll(bytes)
                yield* logs.all.writeAll(bytes)
                entry.info.output = (entry.info.output + chunk.text).slice(-30_000)
                entry.revision++
                yield* Queue.offer(dirty, undefined)
              }),
            ),
            Effect.forkScoped,
          )
          // Kill before output consumers close their pipes; otherwise the leader may
          // look exited while a descendant still holds stdout/stderr and keeps running.
          yield* Effect.addFinalizer(() => handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.ignore))
          yield* Deferred.succeed(ready, undefined)
          const exitCode =
            process.platform === "win32"
              ? handle.exitCode
              : Effect.raceFirst(
                  handle.exitCode,
                  Effect.gen(function* () {
                    while (true) {
                      yield* Effect.sleep("1 second")
                      if (Shell.alive(handle.pid)) continue
                      return yield* Effect.fail(new Error("Shell process exited before its output streams closed"))
                    }
                  }),
                )
          const completed = Effect.all([exitCode, Fiber.join(output)], { concurrency: "unbounded" })
          const [code] = yield* input.timeout === undefined
            ? completed
            : completed.pipe(
                Effect.timeoutOrElse({
                  duration: input.timeout,
                  orElse: () => Effect.fail(new Error(`Shell timed out after ${input.timeout} ms`)),
                }),
              )
          entry.info.exit = code
          if (code !== 0) return yield* Effect.fail(new Error(`Shell exited with code ${code}`))
          return entry.info.output
        }),
      ).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            entry.info.status = Exit.isSuccess(exit)
              ? "completed"
              : Cause.hasInterruptsOnly(exit.cause)
                ? "cancelled"
                : "error"
            entry.info.stdinOpen = false
            entry.info.completedAt = yield* Clock.currentTimeMillis
            if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
              entry.info.error = error(Cause.squash(exit.cause)).message
            entry.revision++
            yield* Queue.offer(dirty, undefined)
            yield* Queue.end(stdin)
            yield* Deferred.fail(ready, new Error(entry.info.error ?? "Shell cancelled before startup"))
            if (input.onComplete && entry.info.status !== "cancelled") {
              yield* input
                .onComplete({ ...entry.info })
                .pipe(Effect.andThen(Deferred.succeed(delivered, undefined)), Effect.forkIn(data.scope), Effect.asVoid)
            }
            if (!input.onComplete || entry.info.status === "cancelled") yield* Deferred.succeed(delivered, undefined)
          }),
        ),
      )
      // Transfer ownership after startup acknowledges the process. Interruption
      // during this handoff must close the new job, even if admission just finished.
      return yield* Effect.acquireUseRelease(
        jobs
          .start({
            id: entry.info.id,
            type: "shell",
            title: input.command,
            metadata: { sessionId: input.sessionID, ancestorSessionIds: input.ancestors, background: true, outputPath },
            run: Effect.interruptible(run),
          })
          .pipe(Effect.tap(() => Effect.sync(() => data.entries.set(entry.info.id, entry)))),
        () =>
          Effect.gen(function* () {
            if (input.onUpdate) {
              const update = input.onUpdate
              yield* Effect.gen(function* () {
                while (true) {
                  yield* Queue.take(dirty)
                  if (entry.info.status === "running") yield* Effect.sleep("200 millis")
                  while (true) {
                    const info = { ...entry.info }
                    const settled = yield* update(info)
                    if (settled && info.status !== "running") {
                      yield* Deferred.succeed(projected, undefined)
                      return
                    }
                    if (settled) break
                    // A false acknowledgement means the foreground tool part is
                    // still being admitted. Retry only this delivery handshake.
                    yield* Effect.sleep("200 millis")
                  }
                }
              }).pipe(Effect.forkIn(data.scope), Effect.asVoid)
              if (flags.experimentalJobOutputRelease)
                yield* Effect.gen(function* () {
                  yield* Deferred.await(projected)
                  yield* Deferred.await(delivered)
                  yield* jobs.wait({ id: entry.info.id })
                  const tailPath = `${entry.info.outputPath}.tail`
                  // Persist before releasing either resident copy. Tail payloads
                  // share truncation's seven-day retention; descriptors outlive them.
                  yield* fs.writeFileString(tailPath, entry.info.output)
                  const tailExpiresAt = (yield* Clock.currentTimeMillis) + 7 * 24 * 60 * 60 * 1000
                  yield* jobs.acknowledge(entry.info.id, {
                    load: fs
                      .readFileString(tailPath)
                      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined))),
                    expiresAt: tailExpiresAt,
                  })
                  data.entries.set(entry.info.id, {
                    info: { ...entry.info, output: "" },
                    ancestors: entry.ancestors,
                    revision: entry.revision,
                    tailPath,
                    tailExpiresAt,
                  })
                }).pipe(Effect.forkIn(data.scope), Effect.asVoid)
            }
            yield* Deferred.await(ready)
            return { ...entry.info }
          }),
        (_, exit) => (Exit.hasInterrupts(exit) ? jobs.cancel(entry.info.id).pipe(Effect.asVoid) : Effect.void),
      )
    })

    const list: Interface["list"] = Effect.fn("BackgroundShell.list")(function* (sessionID) {
      const data = yield* InstanceState.get(state)
      return yield* Effect.forEach(
        Array.from(data.entries.values()).filter(
          (entry) => entry.info.sessionID === sessionID || entry.ancestors.includes(sessionID),
        ),
        snapshot,
        { concurrency: 8 },
      ).pipe(Effect.orDie)
    })
    const get: Interface["get"] = Effect.fn("BackgroundShell.get")(function* (sessionID, id) {
      return yield* snapshot(yield* requireEntry(sessionID, id))
    })
    const input: Interface["input"] = Effect.fn("BackgroundShell.input")(function* (sessionID, id, text, eof = false) {
      const entry = yield* requireEntry(sessionID, id)
      if (entry.info.status !== "running" || !entry.info.stdinOpen || !entry.stdin)
        return yield* Effect.fail(new Error("Shell stdin is closed"))
      if (Buffer.byteLength(text) > 64 * 1024)
        return yield* Effect.fail(new Error("Shell input is limited to 64 KiB per call"))
      if (eof) entry.info.stdinOpen = false
      if (text && !(yield* Queue.offer(entry.stdin, new TextEncoder().encode(text)))) {
        return yield* Effect.fail(new Error("Shell stdin is closed"))
      }
      if (eof) yield* Queue.end(entry.stdin)
      entry.revision++
      if (entry.dirty) yield* Queue.offer(entry.dirty, undefined)
      return yield* snapshot(entry)
    })
    const cancel: Interface["cancel"] = Effect.fn("BackgroundShell.cancel")(function* (sessionID, id) {
      const entry = yield* requireEntry(sessionID, id)
      yield* jobs.cancel(id)
      return yield* snapshot(entry)
    })
    const output: Interface["output"] = Effect.fn("BackgroundShell.output")(function* (input) {
      const entry = yield* requireEntry(input.sessionID, input.id)
      if (input.wait) yield* jobs.wait({ id: input.id, timeout: Math.min(input.wait, 30_000) })
      const path =
        input.stream === "stdout"
          ? entry.info.stdoutPath
          : input.stream === "stderr"
            ? entry.info.stderrPath
            : entry.info.outputPath
      const limit = Math.min(input.limit ?? 200, 1000)
      const lines = yield* fs.stream(path).pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.zipWithIndex,
        Stream.map(([text, index]) => ({ line: index + 1, text })),
        Stream.filter(
          (item) =>
            item.line >= (input.offset ?? 1) &&
            (!input.query || item.text.toLowerCase().includes(input.query.toLowerCase())),
        ),
        Stream.take(limit + 1),
        Stream.runCollect,
        Effect.mapError(error),
      )
      return {
        info: yield* snapshot(entry),
        path,
        lines: lines.slice(0, limit).map((item) => ({ ...item, text: item.text.slice(0, 2000) })),
        more: lines.length > limit,
        nextOffset: (lines.slice(0, limit).at(-1)?.line ?? (input.offset ?? 1) - 1) + 1,
      }
    })
    return Service.of({ start, list, get, input, cancel, output })
  }),
)

function error(cause: unknown) {
  return cause instanceof Error ? cause : new Error(String(cause))
}

export function metadata(info: Info) {
  return {
    background: true,
    jobId: info.id,
    shellStatus: info.status,
    output: info.output,
    outputPath: info.outputPath,
    stdoutPath: info.stdoutPath,
    stderrPath: info.stderrPath,
    stdinOpen: info.stdinOpen,
    pid: info.pid,
    exit: info.exit ?? null,
    error: info.error,
    outputAvailability: info.outputAvailability,
    outputExpiresAt: info.outputExpiresAt,
    outputError: info.outputError,
    truncated: false,
  }
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [BackgroundJob.node, FSUtil.node, CrossSpawnSpawner.node, Truncate.node, RuntimeFlags.node],
})
export * as BackgroundShell from "./shell"

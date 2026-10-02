import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Shell } from "@opencode-ai/core/shell"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { Truncate } from "@/tool/truncate"
import { BackgroundJob } from "@/background/job"
import { BackgroundShell } from "@/background/shell"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionWorkState } from "@/session/work-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ShellTool, type Parameters } from "@/tool/shell"
import { ToolRegistry } from "@/tool/registry"
import type { Tool } from "@/tool/tool"
import type { SessionPrompt } from "@/session/prompt"
import { disposeAllInstancesEffect, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      ToolRegistry.node,
      SessionRunState.node,
      SessionWorkState.node,
      BackgroundShell.node,
      BackgroundJob.node,
      Session.node,
      SessionProjector.node,
      Agent.node,
      FSUtil.node,
      Config.node,
      Plugin.node,
      Truncate.node,
      RuntimeFlags.node,
      CrossSpawnSpawner.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer({ bashDefaultTimeoutMs: 10 })]],
  ),
)
const code = (script: string) => `"${process.execPath}" -e '${script.replaceAll("'", "'\\''")}'`

const fixture = Effect.fn("BackgroundShellTest.fixture")(function* (params: Parameters, parentID?: SessionID) {
  const sessions = yield* Session.Service
  const fs = yield* FSUtil.Service
  const shells = yield* BackgroundShell.Service
  const instance = yield* TestInstance
  const chat = yield* sessions.create({ title: "Shell fixture", parentID })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    time: { created: Date.now() },
  })
  const assistant = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: instance.directory, root: instance.directory },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    time: { created: Date.now() },
  })
  const part: SessionV1.ToolPart = {
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID: chat.id,
    callID: "shell-call",
    type: "tool",
    tool: "bash",
    state: { status: "running", input: params, time: { start: Date.now() }, metadata: {} },
  }
  yield* sessions.updatePart(part)
  const notifications: SessionPrompt.PromptInput[] = []
  const ctx: Tool.Context = {
    sessionID: chat.id,
    messageID: assistant.id,
    callID: part.callID,
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    ask: () => Effect.void,
    metadata: (input) =>
      sessions
        .updatePart({
          ...part,
          state: {
            ...part.state,
            status: "running",
            title: input.title,
            metadata: input.metadata ?? {},
            time: { start: Date.now() },
          },
        })
        .pipe(Effect.asVoid),
    extra: {
      promptOps: {
        cancel: () => Effect.void,
        resolvePromptParts: (text: string) => Effect.succeed([{ type: "text" as const, text }]),
        prompt: (input: SessionPrompt.PromptInput) =>
          Effect.sync(() => {
            notifications.push(input)
            return { info: assistant, parts: [] }
          }),
      },
    },
  }
  const tool = yield* ShellTool
  const def = yield* tool.init()
  const result = yield* def.execute(params, ctx)
  if (!result.metadata.jobId) throw new Error("No background job ID returned")
  const info = yield* shells.get(chat.id, result.metadata.jobId)
  yield* Effect.addFinalizer(() =>
    shells.cancel(chat.id, info.id).pipe(
      Effect.ignore,
      Effect.andThen(
        Effect.all(
          [info.outputPath, info.stdoutPath, info.stderrPath].map((file) => fs.remove(file).pipe(Effect.ignore)),
          { discard: true },
        ),
      ),
    ),
  )
  yield* sessions.updatePart({
    ...part,
    state: {
      status: "completed",
      input: params,
      title: result.title,
      metadata: result.metadata,
      output: result.output,
      time: { start: Date.now(), end: Date.now() },
    },
  })
  return { chat, assistant, user, part, ctx, info, result, notifications }
})

describe("background shells", () => {
  it.instance("reconciles orphaned shell metadata even when its PID has been reused", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const shells = yield* BackgroundShell.Service
      const setup = yield* fixture({
        background: true,
        stdin: true,
        command: code("for await (const chunk of Bun.stdin.stream()) {}"),
      })
      const current = yield* sessions.getPart({
        sessionID: setup.chat.id,
        messageID: setup.assistant.id,
        partID: setup.part.id,
      })
      if (current?.type !== "tool" || current.state.status !== "completed") throw new Error("Missing shell part")
      const live = (yield* sessions.messages({ sessionID: setup.chat.id, limit: 10 }))
        .flatMap((message) => message.parts)
        .find((part) => part.id === setup.part.id)
      expect(live?.type === "tool" && "metadata" in live.state && live.state.metadata?.shellStatus).toBe("running")
      yield* sessions.updatePart({
        ...current,
        state: {
          ...current.state,
          metadata: { ...current.state.metadata, jobId: "job_from_previous_process", pid: process.pid },
        },
      })
      const history = yield* sessions.messages({ sessionID: setup.chat.id, limit: 10 })
      const part = history.flatMap((message) => message.parts).find((part) => part.id === setup.part.id)
      if (part?.type !== "tool" || !("metadata" in part.state)) throw new Error("Missing reconciled shell")
      expect(part.state.metadata?.shellStatus).toBe("cancelled")
      expect(part.state.metadata?.stdinOpen).toBe(false)
      expect((yield* shells.get(setup.chat.id, setup.info.id)).status).toBe("running")
      const stored = yield* sessions.getPart({
        sessionID: setup.chat.id,
        messageID: setup.assistant.id,
        partID: setup.part.id,
      })
      expect(stored?.type === "tool" && "metadata" in stored.state && stored.state.metadata?.shellStatus).toBe(
        "cancelled",
      )
      const other = yield* fixture({
        background: true,
        stdin: true,
        command: code("for await (const chunk of Bun.stdin.stream()) {}"),
      })
      yield* sessions.updatePart({
        ...current,
        state: { ...current.state, metadata: { ...current.state.metadata, jobId: other.info.id, pid: other.info.pid } },
      })
      const unrelated = (yield* sessions.messages({ sessionID: setup.chat.id, limit: 10 }))
        .flatMap((message) => message.parts)
        .find((part) => part.id === setup.part.id)
      expect(unrelated?.type === "tool" && "metadata" in unrelated.state && unrelated.state.metadata?.shellStatus).toBe(
        "cancelled",
      )
      expect((yield* shells.get(other.chat.id, other.info.id)).status).toBe("running")
    }),
  )

  it.instance("cancels an owned job whose recorded shell PID is no longer live", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const shells = yield* BackgroundShell.Service
      const jobs = yield* BackgroundJob.Service
      const setup = yield* fixture({
        background: true,
        stdin: true,
        command: code("for await (const chunk of Bun.stdin.stream()) {}"),
      })
      const current = yield* sessions.getPart({
        sessionID: setup.chat.id,
        messageID: setup.assistant.id,
        partID: setup.part.id,
      })
      if (current?.type !== "tool" || current.state.status !== "completed") throw new Error("Missing shell part")
      const exited = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" })
      yield* Effect.promise(() => exited.exited)
      expect(Shell.alive(exited.pid)).toBe(false)
      yield* sessions.updatePart({
        ...current,
        state: { ...current.state, metadata: { ...current.state.metadata, pid: exited.pid } },
      })
      const history = yield* sessions.messages({ sessionID: setup.chat.id })
      const part = history.flatMap((message) => message.parts).find((part) => part.id === setup.part.id)
      expect(part?.type === "tool" && "metadata" in part.state && part.state.metadata?.shellStatus).toBe("cancelled")
      expect((yield* jobs.get(setup.info.id))?.status).toBe("cancelled")
      expect((yield* shells.get(setup.chat.id, setup.info.id)).stdinOpen).toBe(false)
      const pid = setup.info.pid
      if (pid === undefined) throw new Error("Missing shell PID")
      yield* pollWithTimeout(
        Effect.sync(() => (!Shell.alive(pid) ? true : undefined)),
        "owned shell PID survived cancellation",
      )
    }),
  )

  it.instance("closes live background shell processes when the instance shuts down", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const setup = yield* fixture({
        background: true,
        stdin: true,
        command: code("for await (const chunk of Bun.stdin.stream()) {}"),
      })
      const pid = setup.info.pid
      if (pid === undefined) throw new Error("Missing shell PID")
      const part = yield* sessions.getPart({
        sessionID: setup.chat.id,
        messageID: setup.assistant.id,
        partID: setup.part.id,
      })
      if (part?.type !== "tool" || part.state.status !== "completed") throw new Error("Missing shell part")
      expect(Shell.alive(pid)).toBe(true)
      yield* disposeAllInstancesEffect
      yield* pollWithTimeout(
        Effect.sync(() => (!Shell.alive(pid) ? true : undefined)),
        "background shell survived instance shutdown",
      )
      // A restart loses the process-local job registry even if the last saved tool update was still running.
      expect(yield* jobs.get(setup.info.id)).toBeUndefined()
      yield* sessions.updatePart(part)
      const history = yield* sessions.messages({ sessionID: setup.chat.id })
      const recovered = history.flatMap((message) => message.parts).find((item) => item.id === part.id)
      expect(recovered?.type === "tool" && "metadata" in recovered.state && recovered.state.metadata?.shellStatus).toBe(
        "cancelled",
      )
    }),
  )

  it.instance("forks stationary snapshots without inheriting live shells, tasks, or their callbacks", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const shells = yield* BackgroundShell.Service
      const jobs = yield* BackgroundJob.Service
      const runs = yield* SessionRunState.Service
      const activity = yield* SessionWorkState.Service
      const setup = yield* fixture({
        background: true,
        stdin: true,
        command: code("for await (const chunk of Bun.stdin.stream()) console.log(new TextDecoder().decode(chunk))"),
      })
      const child = yield* sessions.create({ parentID: setup.chat.id, title: "Live background task" })
      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { sessionId: child.id, parentSessionId: setup.chat.id },
        run: Effect.never,
      })
      yield* sessions.updatePart({
        ...setup.part,
        id: PartID.ascending(),
        callID: "live-task",
        tool: "task",
        state: {
          status: "running",
          input: { prompt: "Keep working" },
          metadata: { background: true, jobId: child.id, sessionId: child.id, parentSessionId: setup.chat.id },
          time: { start: Date.now() },
        },
      })
      yield* sessions.updatePart({
        ...setup.part,
        id: PartID.ascending(),
        callID: "pending-shell",
        state: { status: "pending", input: { command: "echo pending" }, raw: "" },
      })
      const ready = yield* Deferred.make<void>()
      yield* runs
        .startShell(
          setup.chat.id,
          Effect.succeed({ info: setup.assistant, parts: [] }),
          Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(ready)

      const fork = yield* sessions.fork({ sessionID: setup.chat.id })
      const history = yield* sessions.messages({ sessionID: fork.id })
      const copied = history.find((message) => message.info.role === "assistant")
      if (!copied || copied.info.role !== "assistant") throw new Error("missing forked assistant")
      expect(copied.info.time.completed).toBeDefined()
      expect(copied.info.error?.name).toBe("MessageAbortedError")
      expect(copied.parts).toContainEqual(
        expect.objectContaining({
          tool: "bash",
          state: expect.objectContaining({
            status: "completed",
            metadata: expect.objectContaining({ shellStatus: "cancelled", stdinOpen: false }),
          }),
        }),
      )
      expect(copied.parts).toContainEqual(
        expect.objectContaining({
          tool: "task",
          state: expect.objectContaining({ status: "error", error: "Execution stopped in fork" }),
        }),
      )
      expect(copied.parts).toContainEqual(
        expect.objectContaining({
          callID: "pending-shell",
          state: expect.objectContaining({ status: "error", error: "Execution stopped in fork" }),
        }),
      )
      for (const part of copied.parts) {
        if (part.type !== "tool" || !("metadata" in part.state)) continue
        expect(part.state.metadata?.jobId).toBeUndefined()
        expect(part.state.metadata?.pid).toBeUndefined()
        expect(part.state.metadata?.sessionId).toBeUndefined()
        expect(part.state.metadata?.parentSessionId).toBeUndefined()
      }
      expect(yield* activity.get(fork.id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
      expect(yield* shells.list(fork.id)).toEqual([])
      expect(yield* sessions.children(fork.id)).toEqual([])
      expect(Exit.isFailure(yield* shells.get(fork.id, setup.info.id).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* shells.input(fork.id, setup.info.id, "spill").pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* shells.cancel(fork.id, setup.info.id).pipe(Effect.exit))).toBe(true)

      yield* runs.cancel(fork.id)
      expect((yield* shells.get(setup.chat.id, setup.info.id)).status).toBe("running")
      expect((yield* jobs.get(child.id))?.status).toBe("running")
      expect((yield* activity.get(setup.chat.id)).foreground).toBe("working")
      const source = yield* sessions.messages({ sessionID: setup.chat.id })
      expect(source.find((message) => message.info.id === setup.assistant.id)?.info.time).toEqual(setup.assistant.time)
      expect(source.flatMap((message) => message.parts)).toContainEqual(
        expect.objectContaining({
          callID: "live-task",
          state: expect.objectContaining({ status: "running" }),
        }),
      )
      yield* shells.input(setup.chat.id, setup.info.id, "source-only\n", true)
      expect((yield* jobs.wait({ id: setup.info.id, timeout: 2000 })).info?.status).toBe("completed")
      yield* pollWithTimeout(
        Effect.sync(() => (setup.notifications.length ? true : undefined)),
        "source completion notification missing",
      )
      expect(setup.notifications.every((notification) => notification.sessionID === setup.chat.id)).toBe(true)
      expect(yield* sessions.messages({ sessionID: fork.id })).toEqual(history)
      expect(yield* activity.get(fork.id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
      yield* runs.cancel(setup.chat.id)
    }),
  )

  it.instance(
    "returns immediately, survives the foreground timeout, and supports stdin/EOF with distinct searchable logs",
    () =>
      Effect.gen(function* () {
        const shells = yield* BackgroundShell.Service
        const jobs = yield* BackgroundJob.Service
        const fs = yield* FSUtil.Service
        const sessions = yield* Session.Service
        const activity = yield* SessionWorkState.Service
        const setup = yield* fixture({
          background: true,
          stdin: true,
          command: code(
            'console.log("early needle");process.stdout.write("x".repeat(35000)+"\\n");console.error("build warning");for await (const chunk of Bun.stdin.stream()) process.stdout.write("input:"+new TextDecoder().decode(chunk));console.log("build finished")',
          ),
        })
        expect(setup.result.output).toContain("Background shell started")
        yield* pollWithTimeout(
          shells
            .output({ sessionID: setup.chat.id, id: setup.info.id, query: "early needle" })
            .pipe(Effect.map((result) => (result.lines.length ? result : undefined))),
          "shell never wrote its readiness output",
        )
        const waiting = yield* shells.output({ sessionID: setup.chat.id, id: setup.info.id, wait: 50 })
        expect(waiting.info.status).toBe("running")
        expect(yield* activity.get(setup.chat.id)).toEqual({
          type: "working",
          foreground: "idle",
          agents: 0,
          shells: 1,
        })
        expect(waiting.info.output).not.toContain("early needle")
        const search = yield* shells.output({
          sessionID: setup.chat.id,
          id: setup.info.id,
          stream: "stdout",
          query: "EARLY NEEDLE",
        })
        expect(search.lines).toEqual([{ line: 1, text: "early needle" }])
        const stderr = yield* shells.output({ sessionID: setup.chat.id, id: setup.info.id, stream: "stderr" })
        expect(stderr.lines.map((line) => line.text)).toContain("build warning")
        yield* shells.input(setup.chat.id, setup.info.id, "hello\n", true)
        expect((yield* jobs.wait({ id: setup.info.id, timeout: 2000 })).info?.status).toBe("completed")
        expect(yield* activity.get(setup.chat.id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
        expect(yield* fs.readFileString(setup.info.stdoutPath)).toContain("input:hello")
        expect(yield* fs.readFileString(setup.info.stderrPath)).not.toContain("input:hello")
        expect((yield* shells.get(setup.chat.id, setup.info.id)).stdinOpen).toBe(false)
        expect(Exit.isFailure(yield* shells.input(setup.chat.id, setup.info.id, "late").pipe(Effect.exit))).toBe(true)
        const projected = yield* pollWithTimeout(
          sessions
            .getPart({ sessionID: setup.chat.id, messageID: setup.assistant.id, partID: setup.part.id })
            .pipe(
              Effect.map((part) =>
                part?.type === "tool" && "metadata" in part.state && part.state.metadata?.shellStatus === "completed"
                  ? part
                  : undefined,
              ),
            ),
          "completed shell status was not projected",
        )
        expect(projected.state.status).toBe("completed")
        yield* pollWithTimeout(
          Effect.sync(() => (setup.notifications.length ? true : undefined)),
          "completion notification missing",
        )
        expect(setup.notifications[0].parts[0]).toMatchObject({ synthetic: true, type: "text" })
      }),
  )

  it.instance("preserves nonzero exit codes, stderr, log pagination, and explicit timeout failures", () =>
    Effect.gen(function* () {
      const shells = yield* BackgroundShell.Service
      const jobs = yield* BackgroundJob.Service
      const activity = yield* SessionWorkState.Service
      const setup = yield* fixture({
        background: true,
        command: code(
          'require("fs").writeSync(1,"one\\ntwo\\nthree\\n");require("fs").writeSync(2,"failure\\n");process.exitCode=7',
        ),
      })
      expect((yield* jobs.wait({ id: setup.info.id, timeout: 2000 })).info?.status).toBe("error")
      expect(yield* activity.get(setup.chat.id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
      const output = yield* shells.output({ sessionID: setup.chat.id, id: setup.info.id, stream: "stdout", limit: 2 })
      expect(output.info.exit).toBe(7)
      expect(output.lines.map((line) => line.text)).toEqual(["one", "two"])
      expect(output.more).toBe(true)
      const next = yield* shells.output({
        sessionID: setup.chat.id,
        id: setup.info.id,
        stream: "stdout",
        offset: output.nextOffset,
      })
      expect(next.lines).toEqual([{ line: 3, text: "three" }])
      const timed = yield* fixture({ background: true, timeout: 50, command: code("setInterval(() => {}, 1000)") })
      yield* jobs.wait({ id: timed.info.id, timeout: 2000 })
      expect((yield* shells.get(timed.chat.id, timed.info.id)).error).toContain("timed out")
      expect(yield* activity.get(timed.chat.id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
    }),
  )

  if (process.platform !== "win32") {
    it.instance("stops a descendant that keeps pipes open after its shell PID exits", () =>
      Effect.gen(function* () {
        const shells = yield* BackgroundShell.Service
        const jobs = yield* BackgroundJob.Service
        const setup = yield* fixture({
          background: true,
          command: code(
            `Bun.spawn([process.execPath,"-e",'console.log("childpid:"+process.pid);setInterval(()=>{},1000)'],{stdout:"inherit",stderr:"inherit"}).unref();console.log("parentpid:"+process.pid)`,
          ),
        })
        const result = yield* pollWithTimeout(
          shells
            .output({ sessionID: setup.chat.id, id: setup.info.id })
            .pipe(
              Effect.map((output) =>
                output.lines.some((line) => line.text.startsWith("childpid:")) ? output : undefined,
              ),
            ),
          "descendant never inherited the shell output",
        )
        const child = Number(result.lines.find((line) => line.text.startsWith("childpid:"))?.text.split(":")[1])
        expect(Number.isInteger(child)).toBe(true)
        expect((yield* jobs.wait({ id: setup.info.id, timeout: 4000 })).info?.status).toBe("error")
        yield* pollWithTimeout(
          Effect.sync(() => (!Shell.alive(child) ? true : undefined)),
          "orphaned shell descendant survived leader exit",
        )
      }),
    )

    it.instance(
      "parent interruption kills an actual descendant shell process group after its subagent has finished",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const shells = yield* BackgroundShell.Service
          const runState = yield* SessionRunState.Service
          const activity = yield* SessionWorkState.Service
          const parent = yield* sessions.create({ title: "Parent" })
          const child = yield* sessions.create({ parentID: parent.id, title: "Finished subagent" })
          const setup = yield* fixture(
            {
              background: true,
              command: code(
                `const child=Bun.spawn([process.execPath,"-e",'console.log("childpid:"+process.pid);process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdout:"inherit",stderr:"inherit"});console.log("pid:"+process.pid);await child.exited`,
              ),
            },
            child.id,
          )
          const output = yield* pollWithTimeout(
            shells
              .output({ sessionID: parent.id, id: setup.info.id })
              .pipe(
                Effect.map((result) =>
                  result.lines.some((line) => line.text.startsWith("childpid:")) ? result : undefined,
                ),
              ),
            "descendant shell never started",
          )
          const pids = output.lines
            .filter((line) => /^(?:child)?pid:/.test(line.text))
            .map((line) => Number(line.text.split(":")[1]))
          expect(pids.length).toBe(2)
          expect(yield* activity.get(parent.id)).toEqual({ type: "working", foreground: "idle", agents: 0, shells: 1 })
          yield* runState.cancel(parent.id)
          expect((yield* shells.get(parent.id, setup.info.id)).status).toBe("cancelled")
          expect(yield* activity.get(parent.id)).toEqual({ type: "idle", foreground: "idle", agents: 0, shells: 0 })
          for (const pid of pids) {
            yield* pollWithTimeout(
              Effect.try({
                try: () => {
                  process.kill(pid, 0)
                  return undefined
                },
                catch: () => true as const,
              }).pipe(Effect.catch((gone) => Effect.succeed(gone))),
              `process ${pid} survived cancellation`,
            )
          }
          expect(setup.notifications).toEqual([])
          expect((yield* shells.output({ sessionID: parent.id, id: setup.info.id })).lines.length).toBeGreaterThan(0)
        }),
    )
  }

  it.instance("rejects cross-session control and applies authorization before starting a background process", () =>
    Effect.gen(function* () {
      const shells = yield* BackgroundShell.Service
      const jobs = yield* BackgroundJob.Service
      const setup = yield* fixture({
        background: true,
        stdin: true,
        command: code("for await (const chunk of Bun.stdin.stream()) {}"),
      })
      expect(Exit.isFailure(yield* shells.get("unrelated", setup.info.id).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* shells.input("unrelated", setup.info.id, "no").pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* shells.cancel("unrelated", setup.info.id).pipe(Effect.exit))).toBe(true)
      const info = yield* ShellTool
      const tool = yield* info.init()
      const denied = yield* tool
        .execute(
          { command: "echo unauthorized", background: true },
          { ...setup.ctx, ask: () => Effect.die(new Error("denied")) },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      expect((yield* jobs.list()).filter((job) => job.type === "shell")).toHaveLength(1)
      yield* shells.cancel(setup.chat.id, setup.info.id)
      expect((yield* shells.cancel(setup.chat.id, setup.info.id)).status).toBe("cancelled")
    }),
  )

  it.instance("loads a real shell workflow resource and exposes management tools only for that user request", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const setup = yield* fixture({ background: true, command: code('console.log("resource")') })
      const request = {
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      }
      const initial = yield* registry.tools(request)
      expect(initial.filter((tool) => tool.id.startsWith("shell_")).map((tool) => tool.id)).toEqual(["shell_tools"])
      const resource = initial.find((tool) => tool.id === "shell_tools")
      if (!resource) throw new Error("Missing resource loader")
      const result = yield* resource.execute({}, setup.ctx)
      expect(result.output).toContain("## Stdio")
      expect(result.output).toContain("bun run build")
      expect(result.output).toContain("shell_output")
      const messages: SessionV1.WithParts[] = [
        { info: setup.user, parts: [] },
        {
          info: setup.assistant,
          parts: [
            {
              ...setup.part,
              tool: "shell_tools",
              state: {
                status: "completed",
                input: {},
                title: result.title,
                output: result.output,
                metadata: result.metadata,
                time: { start: 1, end: 2 },
              },
            },
          ],
        },
      ]
      const loaded = yield* registry.tools({ ...request, messages })
      expect(loaded.filter((tool) => tool.id.startsWith("shell_")).map((tool) => tool.id)).toEqual(
        expect.arrayContaining(["shell_tools", "shell_list", "shell_output", "shell_input", "shell_stop"]),
      )
      const following = yield* registry.tools({
        ...request,
        messages: [...messages, { info: { ...setup.user, id: MessageID.ascending() }, parts: [] }],
      })
      expect(following.filter((tool) => tool.id.startsWith("shell_")).map((tool) => tool.id)).toEqual(["shell_tools"])
    }),
  )

  it.instance("management tool calls write stdin, search output, list jobs, and stop the real process", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const shells = yield* BackgroundShell.Service
      const setup = yield* fixture({
        background: true,
        stdin: true,
        command: code(
          'for await (const chunk of Bun.stdin.stream()) process.stdout.write("echo:"+new TextDecoder().decode(chunk))',
        ),
      })
      const tools = new Map((yield* registry.all()).map((tool) => [tool.id, tool]))
      const input = tools.get("shell_input")
      const output = tools.get("shell_output")
      const list = tools.get("shell_list")
      const stop = tools.get("shell_stop")
      if (!input || !output || !list || !stop) throw new Error("Missing shell management tools")
      const asks: string[] = []
      yield* input.execute(
        { job_id: setup.info.id, text: "hello world\n" },
        {
          ...setup.ctx,
          ask: (request) =>
            Effect.sync(() => {
              asks.push(request.permission)
            }),
        },
      )
      expect(asks).toEqual(["bash"])
      yield* pollWithTimeout(
        shells
          .output({ sessionID: setup.chat.id, id: setup.info.id, query: "hello world" })
          .pipe(Effect.map((result) => (result.lines.length ? result : undefined))),
        "stdin did not reach process",
      )
      const result = yield* output.execute(
        { job_id: setup.info.id, stream: "stdout", query: "HELLO", limit: 1 },
        setup.ctx,
      )
      expect(result.output).toContain("echo:hello world")
      expect((yield* list.execute({}, setup.ctx)).output).toContain(setup.info.id)
      expect((yield* stop.execute({ job_id: setup.info.id }, setup.ctx)).output).toContain("cancelled")
      expect(setup.notifications).toEqual([])
    }),
  )

  it.instance("session removal cancels its shell and completed subagent shells notify the primary session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const shells = yield* BackgroundShell.Service
      const jobs = yield* BackgroundJob.Service
      const parent = yield* sessions.create({ title: "Primary" })
      const done = yield* fixture({ background: true, command: code('console.log("build done")') }, parent.id)
      yield* jobs.wait({ id: done.info.id, timeout: 2000 })
      yield* pollWithTimeout(
        Effect.sync(() => done.notifications[0]),
        "primary session notification missing",
      )
      expect(done.notifications[0].sessionID).toBe(parent.id)
      const active = yield* fixture(
        { background: true, stdin: true, command: code("for await (const chunk of Bun.stdin.stream()) {}") },
        parent.id,
      )
      const pid = active.info.pid
      if (pid === undefined) throw new Error("Missing shell PID")
      yield* sessions.remove(parent.id)
      expect((yield* shells.get(parent.id, active.info.id)).status).toBe("cancelled")
      yield* pollWithTimeout(
        Effect.sync(() => (!Shell.alive(pid) ? true : undefined)),
        "background shell survived session removal",
      )
      expect(
        yield* sessions.getPart({ sessionID: active.chat.id, messageID: active.assistant.id, partID: active.part.id }),
      ).toBeUndefined()
      expect(active.notifications).toEqual([])
    }),
  )
})

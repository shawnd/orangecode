import { expect } from "bun:test"
import path from "path"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { LayerNode } from "../../src/effect/layer-node"
import { AgentV2 } from "../../src/agent"
import { BackgroundJob } from "../../src/background-job"
import { Database } from "../../src/database/database"
import { EventV2 } from "../../src/event"
import { FileSystemSearch } from "../../src/filesystem/search"
import { Fff } from "../../src/filesystem/fff.bun"
import { FSUtil } from "../../src/fs-util"
import { Location } from "../../src/location"
import { PermissionV2 } from "../../src/permission"
import { Project } from "../../src/project"
import { ProjectTable } from "../../src/project/sql"
import { Pty } from "../../src/pty"
import { QuestionV2 } from "../../src/question"
import { Ripgrep } from "../../src/ripgrep"
import { AbsolutePath } from "../../src/schema"
import { SessionV2 } from "../../src/session"
import { SessionTable } from "../../src/session/sql"
import { SessionRunCoordinator } from "../../src/session/run-coordinator"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { it } from "../lib/effect"

it.live(
  "search retirement preserves a session drain, descendant jobs, a detached PTY and pending approvals",
  () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const database = yield* Database.Service
          const agents = yield* AgentV2.Service
          const jobs = yield* BackgroundJob.Service
          const pty = yield* Pty.Service
          const questions = yield* QuestionV2.Service
          const permissions = yield* PermissionV2.Service
          const events = yield* EventV2.Service
          const sessionID = SessionV2.ID.make("ses_search_lifetime")
          yield* database.db
            .insert(ProjectTable)
            .values({ id: Project.ID.global, worktree: AbsolutePath.make(tmp.path), sandboxes: [] })
            .onConflictDoNothing()
            .run()
          yield* database.db
            .insert(SessionTable)
            .values({
              id: sessionID,
              project_id: Project.ID.global,
              slug: "search-lifetime",
              directory: tmp.path,
              title: "search lifetime",
              version: "test",
              agent: "build",
            })
            .onConflictDoNothing()
            .run()
          yield* agents.transform((editor) =>
            editor.update(AgentV2.ID.make("build"), (agent) => {
              agent.permissions = []
            }),
          )
          const permissionAsked = yield* Deferred.make<PermissionV2.Request>()
          const questionAsked = yield* Deferred.make<QuestionV2.Request>()
          const unsubscribe = yield* events.listen((event) => {
            if (event.type === PermissionV2.Event.Asked.type)
              return Deferred.succeed(permissionAsked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
            if (event.type === QuestionV2.Event.Asked.type)
              return Deferred.succeed(questionAsked, event.data as QuestionV2.Request).pipe(Effect.asVoid)
            return Effect.void
          })
          yield* Effect.addFinalizer(() => unsubscribe)
          const permission = yield* permissions
            .assert({ sessionID, action: "read", resources: ["match.txt"] })
            .pipe(Effect.forkScoped)
          const question = yield* questions
            .ask({ sessionID, questions: [{ question: "Continue?", header: "Continue", options: [] }] })
            .pipe(Effect.forkScoped)
          const permissionRequest = yield* Deferred.await(permissionAsked)
          const questionRequest = yield* Deferred.await(questionAsked)
          const release = yield* Deferred.make<void>()
          const descendantCreated = yield* Deferred.make<BackgroundJob.Info>()
          const parent = yield* jobs.start({
            id: "job_search_lifetime_parent",
            type: "parent",
            run: Effect.gen(function* () {
              const descendant = yield* jobs.start({
                type: "descendant",
                metadata: { parent: "job_search_lifetime_parent" },
                run: Deferred.await(release).pipe(Effect.as("descendant done")),
              })
              yield* Deferred.succeed(descendantCreated, descendant)
              yield* Deferred.await(release)
              return "parent done"
            }),
          })
          const descendant = yield* Deferred.await(descendantCreated)
          const terminal = yield* Effect.acquireRelease(pty.create({ command: "cat", cwd: tmp.path }), (info) =>
            pty.remove(info.id).pipe(Effect.ignore),
          )
          const attached = yield* pty.attach(terminal.id, { onData: () => {}, onEnd: () => {} })
          attached.activate()
          attached.detach()
          yield* Effect.promise(() => Bun.write(path.join(tmp.path, "match.txt"), "needle\n"))
          const pickers: ReturnType<typeof Fff.createWorker>[] = []
          const search = yield* FileSystemSearch.makeIdle(
            FileSystemSearch.makeFff((opts) => {
              const picker = Fff.createWorker(opts)
              pickers.push(picker)
              const find = picker.fileSearch.bind(picker)
              picker.fileSearch = async (query, options, signal) => {
                await picker.waitForScan(5000, signal)
                return find(query, options, signal)
              }
              return picker
            }),
            30,
          )
          expect(yield* search.find({ query: "match", type: "file" })).toHaveLength(1)
          const drainStarted = yield* Deferred.make<void>()
          const coordinator = yield* SessionRunCoordinator.make({
            drain: () => Deferred.succeed(drainStarted, undefined).pipe(Effect.andThen(Deferred.await(release))),
          })
          const drain = yield* coordinator.run(sessionID).pipe(Effect.forkScoped)
          yield* Deferred.await(drainStarted)
          yield* Effect.sleep(150)
          expect(pickers[0].state.destroyed).toBe(true)
          expect(Array.from(yield* coordinator.active)).toEqual([sessionID])
          expect(drain.pollUnsafe()).toBeUndefined()
          expect((yield* jobs.get(parent.id))?.status).toBe("running")
          expect((yield* jobs.get(descendant.id))?.status).toBe("running")
          expect((yield* pty.get(terminal.id)).status).toBe("running")
          expect(yield* permissions.list()).toContainEqual(permissionRequest)
          expect(yield* questions.list()).toContainEqual(questionRequest)
          expect(permission.pollUnsafe()).toBeUndefined()
          expect(question.pollUnsafe()).toBeUndefined()
          const output = yield* Deferred.make<void>()
          const reattached = yield* pty.attach(terminal.id, {
            onData: (chunk) => {
              if (chunk.includes("after-idle")) Deferred.doneUnsafe(output, Effect.void)
            },
            onEnd: () => {},
          })
          reattached.activate()
          reattached.write("after-idle\n")
          yield* Deferred.await(output).pipe(Effect.timeout("2 seconds"))
          yield* permissions.reply({ requestID: permissionRequest.id, reply: "once" })
          yield* questions.reply({ requestID: questionRequest.id, answers: [["Continue"]] })
          yield* Fiber.join(permission)
          expect(yield* Fiber.join(question)).toEqual([["Continue"]])
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(drain)
          expect((yield* jobs.wait({ id: parent.id })).info?.status).toBe("completed")
          expect((yield* jobs.wait({ id: descendant.id })).info?.status).toBe("completed")
          expect(yield* search.find({ query: "match", type: "file" })).toHaveLength(1)
          expect(pickers).toHaveLength(2)
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                Database.node,
                EventV2.node,
                Location.node,
                AgentV2.node,
                BackgroundJob.node,
                Pty.node,
                QuestionV2.node,
                PermissionV2.node,
                FSUtil.node,
                Ripgrep.node,
              ]),
              [[Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))]],
            ),
          ),
        ),
      ),
    ),
  15000,
)

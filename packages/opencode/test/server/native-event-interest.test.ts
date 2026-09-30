import { expect, test } from "bun:test"
import path from "node:path"
import { Database } from "bun:sqlite"
import { createOpencodeClient, type GlobalEvent } from "@opencode-ai/sdk/v2"
import { Daemon } from "../../src/cli/daemon"
import { tmpdir } from "../fixture/fixture"

// Opt-in: exercise the final compiled daemon, rather than a source test server.
test.skipIf(!process.env.NATIVE_EVENT_BIN)(
  "native daemon isolates transcripts and hydrates a real durable tool run",
  async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "project")
    const daemonDir = path.join(tmp.path, "daemon")
    const hits: unknown[] = []
    const baseline = process.env.NATIVE_EVENT_BASELINE === "1"
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        hits.push(await request.json())
        const delta =
          hits.length === 1
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_native",
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({
                        command: "printf native-events-ok",
                        description: "Print probe output",
                      }),
                    },
                  },
                ],
              }
            : hits.length === 2
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_question",
                      type: "function",
                      function: {
                        name: "question",
                        arguments: JSON.stringify({
                          questions: [
                            {
                              question: "Continue?",
                              header: "Probe",
                              options: [{ label: "Yes", description: "Complete probe" }],
                            },
                          ],
                        }),
                      },
                    },
                  ],
                }
              : { content: "native-events-complete" }
        const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
        return new Response(
          chunk({ id: "chatcmpl-native", object: "chat.completion.chunk", choices: [{ index: 0, delta }] }) +
            chunk({
              id: "chatcmpl-native",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: hits.length <= 2 ? "tool_calls" : "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            }) +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    await Bun.write(
      path.join(directory, "opencode.json"),
      JSON.stringify({
        providers: {
          local: {
            api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: provider.url.toString() },
            models: { fake: { limit: { context: 8192, output: 1024 } } },
          },
        },
        agents: {
          build: {
            model: "local/fake",
            permissions: [
              { action: "bash", resource: "*", effect: "ask" },
              { action: "question", resource: "*", effect: "allow" },
            ],
          },
        },
      }),
    )
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: tmp.path,
      OPENCODE_TEST_HOME: tmp.path,
      OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
      XDG_CONFIG_HOME: path.join(tmp.path, "config"),
      XDG_DATA_HOME: path.join(tmp.path, "data"),
      XDG_CACHE_HOME: path.join(tmp.path, "cache"),
      XDG_STATE_HOME: path.join(tmp.path, "state"),
      OPENCODE_DAEMON_DIR: daemonDir,
      OPENCODE_DB: path.join(tmp.path, "data", "opencode", "opencode.db"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_EXPERIMENTAL_EVENT_INTEREST: "1",
      OPENCODE_EXPERIMENTAL_EVENT_SYSTEM: "true",
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: "native-event-test-only",
    }
    const daemon = Bun.spawn([path.resolve(process.env.NATIVE_EVENT_BIN!), "--print-logs", "server", "--daemon"], {
      cwd: directory,
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    })
    const stderr = new Response(daemon.stderr).text()
    const abort = new AbortController()
    const waits: { fn: () => boolean; resolve: () => void }[] = []
    const observed: GlobalEvent[][] = [[], [], []]
    const wait = async (fn: () => boolean) => {
      if (fn()) return
      const done = Promise.withResolvers<void>()
      const timeout = setTimeout(
        () =>
          done.reject(
            new Error(
              `native event condition timed out: provider=${hits.length}, events=${JSON.stringify(observed.map((events) => events.map((event) => event.payload.type)))}`,
            ),
          ),
        15000,
      )
      waits.push({ fn, resolve: done.resolve })
      await done.promise.finally(() => clearTimeout(timeout))
    }
    try {
      // Daemon.read has its own readiness/status request; no provider work starts yet.
      const deadline = Date.now() + 15000
      const connection = await (async () => {
        while (Date.now() < deadline) {
          const ready = await Daemon.read(daemonDir)
          if (ready) return ready
          await Bun.sleep(20)
        }
        throw new Error("native daemon did not become ready")
      })()
      const attachment = await Daemon.attach(connection)
      const client = createOpencodeClient({
        baseUrl: attachment.url,
        headers: attachment.headers,
        directory,
        throwOnError: true,
      })
      const modelDeadline = Date.now() + 15000
      while (true) {
        const models = await client.v2.model.list({ location: { directory } })
        if (models.data?.data.some((model) => model.providerID === "local" && model.id === "fake")) break
        if (Date.now() >= modelDeadline)
          throw new Error(`native model never became available: ${JSON.stringify(models.data)}`)
        await Bun.sleep(20)
      }
      const session = await client.v2.session.create({
        location: { directory },
        model: { id: "fake", providerID: "local" },
        agent: "build",
      })
      const sessionID = session.data!.data.id
      const child = await client.v2.session.create({
        location: { directory },
        model: { id: "fake", providerID: "local" },
        agent: "build",
      })
      const childID = child.data!.data.id
      const unrelated = await client.v2.session.create({
        location: { directory },
        model: { id: "fake", providerID: "local" },
        agent: "build",
      })
      const unrelatedID = unrelated.data!.data.id
      // The public V2 create API has no parent field. Seed persisted ancestry
      // before subscription; provider execution and message projection stay native.
      const db = new Database(env.OPENCODE_DB, { readwrite: true, create: false })
      db.query("UPDATE session SET parent_id = ? WHERE id = ?").run(sessionID, childID)
      db.close()
      const streams = await Promise.all([
        client.global.event({ sessions: sessionID, signal: abort.signal, sseMaxRetryAttempts: 0 }),
        client.global.event({ sessions: "", signal: abort.signal, sseMaxRetryAttempts: 0 }),
        client.global.event({ signal: abort.signal, sseMaxRetryAttempts: 0 }),
      ])
      const readers = streams.map((stream, index) =>
        (async () => {
          for await (const event of stream.stream) {
            observed[index].push(event)
            waits.filter((item) => item.fn()).forEach((item) => item.resolve())
          }
        })().catch((error) => {
          if (!abort.signal.aborted) throw error
        }),
      )
      await wait(() => observed.every((events) => events.some((event) => event.payload.type === "server.connected")))
      if (!baseline) {
        const connected = observed[0].find((event) => event.payload.type === "server.connected")!.payload
        expect(connected.type === "server.connected" && connected.properties.sessions).toContainEqual({
          id: childID,
          parentID: sessionID,
        })
      }
      const cpu = process.cpuUsage()
      const started = performance.now()
      await client.v2.session.prompt({ sessionID, prompt: { text: "Run the local probe tool" } })
      await wait(() => observed.every((events) => events.some((event) => event.payload.type === "permission.v2.asked")))
      const request = observed[0].find((event) => event.payload.type === "permission.v2.asked")!.payload
      if (request.type !== "permission.v2.asked") throw new Error("missing native permission request")
      expect((await client.v2.session.permission.list({ sessionID })).data!.data[0]?.id).toBe(request.properties.id)
      await client.v2.session.permission.reply({ sessionID, requestID: request.properties.id, reply: "once" })
      await wait(() => observed.every((events) => events.some((event) => event.payload.type === "question.v2.asked")))
      const question = observed[0].find((event) => event.payload.type === "question.v2.asked")!.payload
      if (question.type !== "question.v2.asked") throw new Error("missing native question request")
      expect((await client.v2.session.question.list({ sessionID })).data!.data[0]?.id).toBe(question.properties.id)
      await client.v2.session.question.reply({
        sessionID,
        requestID: question.properties.id,
        questionV2Reply: { answers: [["Yes"]] },
      })
      await wait(() =>
        observed[0].some(
          (event) => event.payload.type === "session.next.step.ended" && event.payload.properties.finish === "stop",
        ),
      )
      const snapshot = await client.v2.session.messages({ sessionID })
      if (!baseline) expect(snapshot.data!.sequence).toBeGreaterThan(0)
      expect(JSON.stringify(snapshot.data!.data)).toContain("native-events-ok")
      expect(JSON.stringify(snapshot.data!.data)).toContain("native-events-complete")
      for (const id of [childID, unrelatedID]) {
        await client.v2.session.prompt({ sessionID: id, prompt: { text: "Complete the probe" } })
        await wait(() =>
          observed[2].some(
            (event) =>
              event.payload.type === "session.next.step.ended" &&
              event.payload.properties.sessionID === id &&
              event.payload.properties.finish === "stop",
          ),
        )
        expect(JSON.stringify((await client.v2.session.messages({ sessionID: id })).data!.data)).toContain(
          "native-events-complete",
        )
      }
      // A globally delivered creation event fences prior transcript queue entries.
      const fence = await client.v2.session.create({ location: { directory } })
      await wait(() =>
        observed.every((events) =>
          events.some(
            (event) =>
              event.payload.type === "session.created" && event.payload.properties.info.id === fence.data!.data.id,
          ),
        ),
      )
      expect(
        observed[0].some(
          (event) => event.payload.type === "session.next.text.ended" && event.payload.properties.sessionID === childID,
        ),
      ).toBe(true)
      expect(
        observed[0].some(
          (event) =>
            event.payload.type === "session.next.text.ended" && event.payload.properties.sessionID === unrelatedID,
        ),
      ).toBe(baseline)
      expect(
        observed[1].some(
          (event) => event.payload.type.startsWith("session.next.") && event.payload.type !== "session.next.moved",
        ),
      ).toBe(baseline)
      expect(
        observed[1].some(
          (event) => event.payload.type === "sync" && event.payload.syncEvent.type.startsWith("session.next.text."),
        ),
      ).toBe(baseline)
      expect(hits.length).toBe(5)
      const elapsedMs = performance.now() - started
      const cpuUsage = process.cpuUsage(cpu)
      if (process.env.NATIVE_EVENT_OUT) {
        const memory = await Promise.all(
          [daemon.pid, process.pid].map(async (pid) => {
            const rollup = await Bun.file(`/proc/${pid}/smaps_rollup`).text()
            return { pid, pssKiB: Number(rollup.match(/^Pss:\s+(\d+)/m)![1]) }
          }),
        )
        const transcripts = observed.map((events) =>
          events.filter(
            (event) =>
              event.payload.type.startsWith("session.next.") ||
              (event.payload.type === "sync" && event.payload.syncEvent.type.startsWith("session.next.")),
          ),
        )
        await Bun.write(
          process.env.NATIVE_EVENT_OUT,
          JSON.stringify(
            {
              arm: baseline ? "baseline" : "after",
              binary: process.env.NATIVE_EVENT_BIN,
              binarySha256: new Bun.CryptoHasher("sha256")
                .update(await Bun.file(process.env.NATIVE_EVENT_BIN!).arrayBuffer())
                .digest("hex"),
              elapsedMs,
              harnessCpuMs: (cpuUsage.user + cpuUsage.system) / 1000,
              postRunPssKiB: memory.reduce((sum, item) => sum + item.pssKiB, 0),
              memory,
              providerCalls: hits.length,
              transcriptEvents: transcripts.map((events) => events.length),
              transcriptJsonBytes: transcripts.map((events) =>
                events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0),
              ),
              allEvents: observed.map((events) => events.length),
            },
            null,
            2,
          ),
        )
      }
      abort.abort()
      await Promise.all(readers)
      await Daemon.request(connection, "stop")
      expect(await daemon.exited).toBe(0)
    } catch (error) {
      console.error("Native probe failure", error, {
        providerCalls: hits.length,
        events: observed.map((events) => events.map((event) => event.payload)),
      })
      throw error
    } finally {
      abort.abort()
      provider.stop(true)
      if (daemon.exitCode === null) daemon.kill()
      await daemon.exited
      const output = await stderr
      if (output) console.error(output)
    }
  },
  60000,
)

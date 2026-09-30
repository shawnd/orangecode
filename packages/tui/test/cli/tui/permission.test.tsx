/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { Part, PermissionRequest } from "@opencode-ai/sdk/v2"
import { expect, test } from "bun:test"
import { createSignal, onCleanup } from "solid-js"
import { ArgsProvider } from "../../../src/context/args"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { PermissionPrompt } from "../../../src/routes/session/permission"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createEventSource, createFetch, directory, json, type FetchHandler } from "../../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { wait } from "../cmd/tui/sync-fixture"

const request: PermissionRequest = {
  id: "per_child",
  sessionID: "ses_child",
  permission: "external_directory",
  patterns: ["/tmp/private/*"],
  always: ["/tmp/private/*"],
  metadata: { command: "cat /tmp/private/config.json" },
}

async function mount(state: string, initial: PermissionRequest, override?: FetchHandler, parts: Part[] = []) {
  const [permission, setPermission] = createSignal(initial)
  const calls = createFetch(override)
  const events = createEventSource()
  const messages: URL[] = []
  const replies: { path: string; body: unknown }[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const outgoing = new Request(input, init)
    const url = new URL(outgoing.url)
    if (url.pathname.includes("/message/")) messages.push(url)
    if (url.pathname.startsWith("/permission/")) {
      replies.push({ path: url.pathname, body: await outgoing.json() })
      return json(true)
    }
    return calls.fetch(input, init)
  }) as typeof fetch
  let sync!: ReturnType<typeof useSync>
  function Probe() {
    sync = useSync()
    if (initial.tool && parts.length) sync.set("part", initial.tool.messageID, parts)
    return <PermissionPrompt request={permission()} directory={directory} />
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={directory} paths={{ state }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <ArgsProvider>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <SDKProvider url="http://test" directory={directory} fetch={fetcher} events={events.source}>
                    <PermissionProvider>
                      <ProjectProvider>
                        <ExitProvider exit={() => {}}>
                          <SyncProvider>
                            <LocationProvider location={{ directory }}>
                              <Probe />
                            </LocationProvider>
                          </SyncProvider>
                        </ExitProvider>
                      </ProjectProvider>
                    </PermissionProvider>
                  </SDKProvider>
                </ThemeProvider>
              </KVProvider>
            </ArgsProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width: 110, height: 35 })
  await wait(() => sync?.status === "complete")
  return { app, sync, setPermission, messages, replies }
}

test("parent permissions show external commands, exact files, and the requesting subagent", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, sync, setPermission } = await mount(tmp.path, request)
  try {
    sync.set("session", [
      {
        id: "ses_child",
        slug: "child",
        parentID: "ses_parent",
        title: "Inspect configuration",
        directory,
        projectID: "proj_test",
        version: "test",
        time: { created: 0, updated: 0 },
      },
    ])
    await app.flush()
    expect(app.captureCharFrame()).toContain("$ cat /tmp/private/config.json")
    expect(app.captureCharFrame()).toContain("Subagent: Inspect configuration")
    expect(app.captureCharFrame()).toContain("/tmp/private/*")

    setPermission({ ...request, metadata: { filepath: "/tmp/private/secrets.json", parentDir: "/tmp/private" } })
    await app.flush()
    expect(app.captureCharFrame()).toContain("Path: /tmp/private/secrets.json")
    expect(app.captureCharFrame()).not.toContain("$ cat")

    setPermission({ ...request, permission: "read", patterns: ["/tmp/private/settings.json"], metadata: {} })
    await app.flush()
    expect(app.captureCharFrame()).toContain("Read /tmp/private/settings.json")

    setPermission({ ...request, permission: "bash", metadata: { command: "git status --short" } })
    await app.flush()
    expect(app.captureCharFrame()).toContain("$ git status --short")

    setPermission({
      ...request,
      permission: "grep",
      metadata: { pattern: "secret", path: "/tmp/private", include: "*.json" },
    })
    await app.flush()
    expect(app.captureCharFrame()).toContain('Grep "secret"')
    expect(app.captureCharFrame()).toContain("Path: /tmp/private")
    expect(app.captureCharFrame()).toContain("Include: *.json")
  } finally {
    app.renderer.destroy()
  }
})

test("parent permissions load missing child tool inputs and update after the fetch", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let resolve!: (response: Response) => void
  const response = new Promise<Response>((done) => {
    resolve = done
  })
  let fetched = false
  const { app, messages } = await mount(
    tmp.path,
    {
      ...request,
      tool: { messageID: "msg_child", callID: "call_child" },
    },
    (url) => {
      if (url.pathname !== "/session/ses_child/message/msg_child") return
      fetched = true
      return response
    },
    [
      {
        id: "prt_child",
        sessionID: "ses_child",
        messageID: "msg_child",
        type: "tool",
        tool: "bash",
        callID: "call_child",
        state: { status: "pending", input: {}, raw: "" },
      },
    ],
  )
  try {
    await wait(() => fetched)
    await app.flush()
    expect(app.captureCharFrame()).toContain("$ cat /tmp/private/config.json")
    expect(app.captureCharFrame()).toContain("Tool: bash")
    expect(messages).toHaveLength(1)
    expect(messages[0].searchParams.get("directory")).toBe(directory)
    resolve(
      json({
        parts: [
          {
            id: "prt_other",
            sessionID: "ses_child",
            messageID: "msg_child",
            type: "tool",
            tool: "bash",
            callID: "call_other",
            state: { status: "running", input: { command: "rm /tmp/private" }, time: { start: 0 } },
          },
          {
            id: "prt_child",
            sessionID: "ses_child",
            messageID: "msg_child",
            type: "tool",
            tool: "bash",
            callID: "call_child",
            state: {
              status: "running",
              input: { command: "ls /tmp/private", workdir: "/tmp/private" },
              time: { start: 0 },
            },
          },
        ],
      }),
    )
    await wait(() => app.captureCharFrame().includes("$ ls /tmp/private"))
    await app.flush()
    expect(app.captureCharFrame()).toContain("$ ls /tmp/private")
    expect(app.captureCharFrame()).toContain("Working directory: /tmp/private")
    expect(app.captureCharFrame()).toContain("Tool: bash")
    expect(app.captureCharFrame()).not.toContain("$ rm")
  } finally {
    app.renderer.destroy()
  }
})

test.each(["grep", "glob"] as const)("external access identifies %s and its search arguments", async (name) => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let resolve!: (response: Response) => void
  const response = new Promise<Response>((done) => {
    resolve = done
  })
  const { app, messages } = await mount(
    tmp.path,
    {
      ...request,
      metadata: { filepath: "/tmp/private", parentDir: "/tmp/private" },
      tool: { messageID: "msg_search", callID: "call_search" },
    },
    (url) => {
      if (url.pathname === "/session/ses_child/message/msg_search") return response
    },
    [
      {
        id: "prt_search",
        sessionID: "ses_child",
        messageID: "msg_search",
        type: "tool",
        tool: name,
        callID: "call_search",
        state: { status: "pending", input: {}, raw: "" },
      },
    ],
  )
  try {
    await app.flush()
    expect(app.captureCharFrame()).toContain("Tool: " + name)
    expect(app.captureCharFrame()).toContain("Path: /tmp/private")
    expect(messages).toHaveLength(1)
    resolve(
      json({
        parts: [
          {
            id: "prt_search",
            sessionID: "ses_child",
            messageID: "msg_search",
            type: "tool",
            tool: name,
            callID: "call_search",
            state: {
              status: "running",
              input: {
                pattern: name === "grep" ? "api_key" : "**/*.json",
                path: "/tmp/private/subdir",
                ...(name === "grep" ? { include: "*.json" } : {}),
              },
              time: { start: 0 },
            },
          },
        ],
      }),
    )
    await wait(() => app.captureCharFrame().includes("Search pattern:"))
    await app.flush()
    expect(app.captureCharFrame()).toContain("Tool: " + name)
    expect(app.captureCharFrame()).toContain("Search path: /tmp/private/subdir")
    expect(app.captureCharFrame()).toContain("Search pattern: " + (name === "grep" ? "api_key" : "**/*.json"))
    if (name === "grep") expect(app.captureCharFrame()).toContain("Include: *.json")
    expect(app.captureCharFrame()).toContain("Permission patterns")
    expect(app.captureCharFrame()).toContain("/tmp/private/*")
    expect(app.captureCharFrame()).not.toContain("$ cat")
  } finally {
    app.renderer.destroy()
  }
})

test("cached child tool inputs are shown without fetching another message", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, sync, messages } = await mount(
    tmp.path,
    {
      ...request,
      permission: "bash",
      tool: { messageID: "msg_child", callID: "call_child" },
    },
    undefined,
    [
      {
        id: "prt_child",
        sessionID: "ses_child",
        messageID: "msg_child",
        type: "tool",
        tool: "bash",
        callID: "call_child",
        state: {
          status: "running",
          input: { command: "git diff --stat", description: "Inspect changes" },
          time: { start: 0 },
        },
      },
    ],
  )
  try {
    await app.flush()
    expect(app.captureCharFrame()).toContain("$ git diff --stat")
    expect(app.captureCharFrame()).toContain("Inspect changes")
    expect(messages).toHaveLength(0)

    sync.set("part", "msg_child", 0, (part) =>
      part.type === "tool" && part.state.status !== "pending"
        ? { ...part, state: { ...part.state, input: { command: "git status --short" } } }
        : part,
    )
    await app.flush()
    expect(app.captureCharFrame()).toContain("$ git status --short")
    expect(app.captureCharFrame()).not.toContain("$ git diff --stat")
    expect(messages).toHaveLength(0)
  } finally {
    app.renderer.destroy()
  }
})

test("missing message details keep fallback information and approval targets the child request", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, messages, replies } = await mount(
    tmp.path,
    {
      ...request,
      tool: { messageID: "msg_missing", callID: "call_missing" },
    },
    (url) => {
      if (url.pathname === "/session/ses_child/message/msg_missing")
        return json({ error: "not found" }, { status: 404 })
    },
  )
  try {
    await app.flush()
    expect(messages).toHaveLength(1)
    expect(app.captureCharFrame()).toContain("$ cat /tmp/private/config.json")
    expect(app.captureCharFrame()).toContain("/tmp/private/*")
    expect(app.captureCharFrame()).toContain("Allow once")
    app.mockInput.pressEnter()
    await wait(() => replies.length === 1)
    expect(replies[0]).toEqual({ path: "/permission/per_child/reply", body: { reply: "once" } })
  } finally {
    app.renderer.destroy()
  }
})

test("late responses from another subagent cannot replace the current permission details", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let resolve!: (response: Response) => void
  const response = new Promise<Response>((done) => {
    resolve = done
  })
  const { app, setPermission, messages } = await mount(
    tmp.path,
    {
      ...request,
      permission: "bash",
      tool: { messageID: "msg_first", callID: "call_first" },
    },
    (url) => {
      if (url.pathname === "/session/ses_child/message/msg_first") return response
      if (url.pathname === "/session/ses_second/message/msg_second")
        return json({
          parts: [
            {
              id: "prt_second",
              sessionID: "ses_second",
              messageID: "msg_second",
              type: "tool",
              tool: "bash",
              callID: "call_second",
              state: { status: "running", input: { command: "git log --oneline" }, time: { start: 0 } },
            },
          ],
        })
    },
  )
  try {
    setPermission({
      ...request,
      id: "per_second",
      sessionID: "ses_second",
      permission: "bash",
      metadata: {},
      tool: { messageID: "msg_second", callID: "call_second" },
    })
    await wait(() => app.captureCharFrame().includes("$ git log --oneline"))
    expect(messages).toHaveLength(2)
    resolve(
      json({
        parts: [
          {
            id: "prt_first",
            sessionID: "ses_child",
            messageID: "msg_first",
            type: "tool",
            tool: "bash",
            callID: "call_first",
            state: { status: "running", input: { command: "rm /tmp/private/config.json" }, time: { start: 0 } },
          },
        ],
      }),
    )
    await response
    await app.flush()
    expect(app.captureCharFrame()).toContain("$ git log --oneline")
    expect(app.captureCharFrame()).not.toContain("$ rm")
  } finally {
    app.renderer.destroy()
  }
})

test("shell pattern fallbacks and custom tool arguments remain visible without tool messages", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, setPermission } = await mount(tmp.path, {
    ...request,
    permission: "bash",
    patterns: ["git status", "git diff"],
    metadata: {},
  })
  try {
    await app.flush()
    expect(app.captureCharFrame()).toContain("git status")
    expect(app.captureCharFrame()).toContain("git diff")
    expect(app.captureCharFrame()).not.toContain("$ ")
    setPermission({
      ...request,
      permission: "custom_tool",
      patterns: ["/tmp/private/data.json"],
      metadata: { action: "inspect" },
    })
    await app.flush()
    expect(app.captureCharFrame()).toContain("Call tool custom_tool")
    expect(app.captureCharFrame()).toContain('"action": "inspect"')
    expect(app.captureCharFrame()).toContain("/tmp/private/data.json")
  } finally {
    app.renderer.destroy()
  }
})

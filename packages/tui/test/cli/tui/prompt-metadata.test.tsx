/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { MouseButton } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { Prompt, type PromptRef } from "../../../src/component/prompt"
import { FrecencyProvider } from "../../../src/component/prompt/frecency"
import { DialogModel } from "../../../src/component/dialog-model"
import { DialogProvider } from "../../../src/component/dialog-provider"
import { DialogVariant } from "../../../src/component/dialog-variant"
import { TuiConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { DataProvider } from "../../../src/context/data"
import { EditorContextProvider } from "../../../src/context/editor"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { LocalProvider, useLocal } from "../../../src/context/local"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { RouteProvider } from "../../../src/context/route"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useBindings } from "../../../src/keymap"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createFetch, directory, eventSource, json, worktree } from "../../fixture/tui-sdk"
import { RemindersProvider } from "../../../src/context/reminders"
import { NativeReminders } from "@opencode-ai/core/native/reminders"

async function mount(root: string, sessionID?: string, variants = true) {
  const dialogUI = await import("../../../src/ui/dialog")
  await Bun.write(`${root}/kv.json`, JSON.stringify({ animations_enabled: false }))
  const provider = {
    id: "metadata-provider",
    name: "Metadata Provider",
    models: {
      "metadata-model": {
        id: "metadata-model",
        providerID: "metadata-provider",
        name: "Metadata Model",
        family: "test",
        api: { id: "metadata-model", url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
        limit: { context: 100000, output: 10000 },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        capabilities: { temperature: true, reasoning: true, attachment: false, toolcall: true },
        variants: variants ? { high: {}, low: {} } : {},
        release_date: "2026-01-01",
      },
    },
  }
  Object.assign(
    provider.models,
    Object.fromEntries(
      ["second", "third"].map((name) => [
        `${name}-model`,
        { ...provider.models["metadata-model"], id: `${name}-model`, name: `${name} Model` },
      ]),
    ),
  )
  const other = { ...provider, id: "other-provider", name: "Other Provider" }
  const calls = createFetch((url) => {
    if (url.pathname === "/config") return json({ model: "metadata-provider/metadata-model" })
    if (url.pathname === "/config/providers")
      return json({ providers: [provider, other], default: { "metadata-provider": "metadata-model" } })
    if (url.pathname === "/provider")
      return json({
        all: [provider, other],
        default: { "metadata-provider": "metadata-model" },
        connected: [provider.id, other.id],
      })
    if (url.pathname === "/agent")
      return json(["build", "plan"].map((name) => ({ name, mode: "primary", permission: [], options: {} })))
    if (url.pathname.startsWith("/session/")) return json([])
  })
  let context: { local: ReturnType<typeof useLocal>; dialog: ReturnType<typeof useDialog> } | undefined
  let prompt: PromptRef | undefined
  function Controls() {
    const local = useLocal()
    const dialog = useDialog()
    const sync = useSync()
    context = { local, dialog }
    // Register app-level commands so clicks exercise real keymap dispatch and picker components.
    useBindings(() => ({
      commands: [
        {
          name: "agent.cycle",
          namespace: "palette",
          title: "Switch agent",
          slashName: "agents",
          run: () => local.agent.move(1),
        },
        {
          name: "model.list",
          namespace: "palette",
          title: "Switch model",
          slashName: "models",
          run: () => dialog.replace(() => <DialogModel />),
        },
        { name: "provider.connect", run: () => dialog.replace(() => <DialogProvider />) },
        { name: "variant.list", run: () => dialog.replace(() => <DialogVariant />) },
      ],
    }))
    return (
      <box paddingTop={10}>
        <Prompt
          sessionID={sessionID}
          visible={sync.ready}
          ref={(ref) => {
            prompt = ref
          }}
        />
      </box>
    )
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ theme: "opencode" })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={directory} paths={{ state: root, home: root, worktree }}>
        <ArgsProvider>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={eventSource()}>
                      <PermissionProvider>
                        <ProjectProvider>
                          <ExitProvider
                            exit={(error) => {
                              throw error ?? new Error("Unexpected exit")
                            }}
                          >
                            <SyncProvider>
                              <DataProvider>
                                <RouteProvider>
                                  <LocalProvider>
                                    <ClipboardProvider value={{}}>
                                      <PromptStashProvider>
                                        <RemindersProvider>
                                          <dialogUI.DialogProvider>
                                            <FrecencyProvider>
                                              <PromptHistoryProvider>
                                                <EditorContextProvider>
                                                  <LocationProvider>
                                                    <Controls />
                                                  </LocationProvider>
                                                </EditorContextProvider>
                                              </PromptHistoryProvider>
                                            </FrecencyProvider>
                                          </dialogUI.DialogProvider>
                                        </RemindersProvider>
                                      </PromptStashProvider>
                                    </ClipboardProvider>
                                  </LocalProvider>
                                </RouteProvider>
                              </DataProvider>
                            </SyncProvider>
                          </ExitProvider>
                        </ProjectProvider>
                      </PermissionProvider>
                    </SDKProvider>
                  </ToastProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </ArgsProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width: 120, height: 30 })
  const waitForFrame = async (predicate: (frame: string) => boolean) => {
    const deadline = Date.now() + 2000
    while (true) {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      if (predicate(frame)) return frame
      if (Date.now() > deadline) throw new Error(`Timed out waiting for prompt frame:\n${frame}`)
      await Bun.sleep(10)
    }
  }
  return {
    app,
    prompt() {
      if (!prompt) throw new Error("Prompt not ready")
      return prompt
    },
    waitForFrame,
    async click(label: string, button: MouseButton.LEFT | MouseButton.RIGHT = MouseButton.LEFT) {
      const frame = await waitForFrame((frame) => frame.includes(label))
      const lines = frame.split("\n")
      const y = lines.findIndex((line) => line.includes(label))
      await app.mockMouse.click(lines[y].indexOf(label) + 1, y, button)
    },
    ctx() {
      if (!context) throw new Error("Prompt contexts not ready")
      return context
    },
    [Symbol.dispose]() {
      app.renderer.destroy()
    },
  }
}

for (const sessionID of [undefined, "metadata-session"]) {
  test(`prompt metadata controls work on ${sessionID ? "chat session" : "home"}`, async () => {
    await using tmp = await tmpdir()
    using view = await mount(tmp.path, sessionID)
    const frame = await view.waitForFrame((frame) => frame.includes("Metadata Model") && frame.includes("default"))
    expect(frame).toContain("Build")

    await view.click("Build")
    await view.waitForFrame((frame) => frame.includes("Plan"))
    expect(view.ctx().local.agent.current()?.name).toBe("plan")
    await view.click("Plan")
    await view.waitForFrame((frame) => frame.includes("Build"))
    expect(view.ctx().local.agent.current()?.name).toBe("build")

    await view.click("Metadata Model")
    await view.waitForFrame((frame) => frame.includes("second Model"))
    expect(view.ctx().local.model.current()).toEqual({ providerID: "metadata-provider", modelID: "second-model" })
    expect(view.ctx().dialog.stack.length).toBe(0)
    await view.click("second Model")
    await view.waitForFrame((frame) => frame.includes("third Model"))
    await view.click("third Model")
    await view.waitForFrame((frame) => frame.includes("Metadata Model"))
    await view.click("Metadata Model", MouseButton.RIGHT)
    await view.waitForFrame((frame) => frame.includes("third Model"))
    await view.click("third Model", MouseButton.RIGHT)
    await view.waitForFrame((frame) => frame.includes("second Model"))
    await view.click("second Model", MouseButton.RIGHT)
    await view.waitForFrame((frame) => frame.includes("Metadata Model"))
    expect(view.ctx().local.model.current()).toEqual({ providerID: "metadata-provider", modelID: "metadata-model" })
    expect(view.ctx().dialog.stack.length).toBe(0)

    await view.click("Metadata Provider")
    await view.waitForFrame((frame) => frame.includes("Connect a provider"))
    view.ctx().dialog.clear()

    await view.click("default")
    await view.waitForFrame((frame) => frame.includes("· high"))
    expect(view.ctx().local.model.variant.current()).toBe("high")
    await view.click("high")
    await view.waitForFrame((frame) => frame.includes("· low"))
    await view.click("low")
    await view.waitForFrame((frame) => frame.includes("· default"))
    expect(view.ctx().local.model.variant.current()).toBeUndefined()
    await view.click("default", MouseButton.RIGHT)
    await view.waitForFrame((frame) => frame.includes("· low"))
    expect(view.ctx().local.model.variant.current()).toBe("low")
    await view.click("low", MouseButton.RIGHT)
    await view.waitForFrame((frame) => frame.includes("· high"))
    await view.click("high", MouseButton.RIGHT)
    await view.waitForFrame((frame) => frame.includes("· default"))
    expect(view.ctx().local.model.variant.current()).toBeUndefined()
    expect(view.ctx().dialog.stack.length).toBe(0)
  })
}

test("chat session displays default variant for a model with no variants", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path, "metadata-session", false)
  const frame = await view.waitForFrame((frame) => frame.includes("Metadata Model") && frame.includes("· default"))
  expect(frame).toContain("· default")
  expect(view.ctx().local.model.variant.list()).toEqual([])
  await view.click("default")
  await view.click("default", MouseButton.RIGHT)
  expect(view.ctx().local.model.variant.current()).toBeUndefined()
  expect(view.ctx().dialog.stack.length).toBe(0)
})

for (const sessionID of [undefined, "metadata-session"]) {
  test(`reminder counter stays in the prompt controls on ${sessionID ? "chat session" : "home"}`, async () => {
    await using tmp = await tmpdir()
    using view = await mount(tmp.path, sessionID)
    const empty = await view.waitForFrame((frame) => frame.includes("Metadata Model") && frame.includes("◷ (0)"))
    const lines = empty.split("\n")
    const row = lines.findIndex((line) => line.includes("◷ (0)"))
    expect(lines[row]).toContain("default")
    expect(lines[row].indexOf("◷")).toBeGreaterThan(lines[row].indexOf("default"))
    expect(lines[row].indexOf("◷")).toBeGreaterThan(80)
    expect(lines.slice(0, row).some((line) => line.includes("◷"))).toBe(false)
    await view.click("◷ (0)")
    await view.waitForFrame((frame) => frame.includes("Reminders · all terminals"))
    view.ctx().dialog.clear()
    const store = NativeReminders.open(`${tmp.path}/reminders.sqlite3`)
    try {
      const reminder = store.create(store.parse("in 20 minutes check CI"))
      await view.waitForFrame((frame) => frame.includes("◷ (1)"))
      await view.click("◷ (1)")
      await view.waitForFrame((frame) => frame.includes("check CI"))
      view.ctx().dialog.clear()
      store.complete(reminder.id)
      await view.waitForFrame((frame) => frame.includes("◷ (0)"))
    } finally {
      store.close()
    }
  })
}

test("submitting reminder slash commands keeps their dialog open and clears the prompt", async () => {
  await using tmp = await tmpdir()
  using view = await mount(tmp.path)
  await view.waitForFrame((frame) => frame.includes("Metadata Model") && frame.includes("◷ (0)"))
  for (const command of ["/remind in 20 minutes check CI", "/reminders ", "/notifications "]) {
    view.prompt().set({ input: command, parts: [] })
    view.app.mockInput.pressEnter()
    await view.waitForFrame((frame) =>
      frame.includes(command.startsWith("/remind ") ? "Confirm reminder" : "Reminders · all terminals"),
    )
    expect(view.prompt().current.input).toBe("")
    view.ctx().dialog.clear()
    const frame = await view.waitForFrame(
      (frame) =>
        frame.includes("Metadata Model") && !frame.includes("all terminals") && !frame.includes("Confirm reminder"),
    )
    expect(frame).not.toContain(command.trim())
  }
})

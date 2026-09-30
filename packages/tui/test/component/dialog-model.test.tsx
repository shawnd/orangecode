/** @jsxImportSource @opentui/solid */
import { InputRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import path from "path"
import { onCleanup } from "solid-js"
import { DialogModel } from "../../src/component/dialog-model"
import { TuiConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { LocalProvider, useLocal } from "../../src/context/local"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { writeJsonAtomic } from "../../src/util/persistence"
import { createModelState } from "../../src/util/model-state"
import { ModelFavorites } from "@opencode-ai/core/model-favorites"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createFetch, directory, eventSource, json } from "../fixture/tui-sdk"

const favorite = { providerID: "openai", modelID: "gpt-6-sol" }
async function wait(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for model palette")
    await Bun.sleep(10)
  }
}

const providers = [
  { id: "openai", name: "OpenAI", modelID: "gpt-6-sol", nameModel: "GPT 6 Sol", date: "2026-08-01" },
  { id: "openrouter", name: "OpenRouter", modelID: "gpt-6.1-sol", nameModel: "GPT 6.1 Sol", date: "2026-09-01" },
  { id: "opencode", name: "OpenCode", modelID: "sol-free", nameModel: "Sol Free", date: "2026-09-01" },
].map((item) => ({
  id: item.id,
  name: item.name,
  models: {
    [item.modelID]: {
      id: item.modelID,
      providerID: item.id,
      name: item.nameModel,
      release_date: item.date,
      cost: { input: item.id === "opencode" ? 0 : 1 },
      variants: {},
    },
  },
}))

async function mount(root: string) {
  const disposals = new Set<Promise<void>>()
  await writeJsonAtomic(path.join(root, "kv.json"), { animations_enabled: false })
  const calls = createFetch((url) => {
    if (url.pathname === "/config/providers") return json({ providers, default: {} })
    if (url.pathname === "/provider")
      return json({ all: providers, connected: providers.map((item) => item.id), default: {} })
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", permission: [], options: {} }])
  })
  let local: ReturnType<typeof useLocal> | undefined
  let sync: ReturnType<typeof useSync> | undefined
  function Palette() {
    local = useLocal()
    sync = useSync()
    return <DialogModel />
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ theme: "opencode" })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={directory} paths={{ state: root, home: root }}>
        <ArgsProvider>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={eventSource()}>
                      <PermissionProvider>
                        <ProjectProvider>
                          <ExitProvider exit={() => {}}>
                            <SyncProvider>
                              <RouteProvider>
                                <LocalProvider onDispose={(done) => disposals.add(done)}>
                                  <DialogProvider>
                                    <Palette />
                                  </DialogProvider>
                                </LocalProvider>
                              </RouteProvider>
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
  const app = await testRender(() => <Harness />, { width: 120, height: 40 })
  await wait(
    () => !!local?.model.ready && !!sync?.ready && app.renderer.currentFocusedEditor instanceof InputRenderable,
  )
  return {
    app,
    local() {
      if (!local) throw new Error("Local preferences did not mount")
      return local
    },
    async frame(predicate: (frame: string) => boolean) {
      await wait(async () => {
        await app.renderOnce()
        return predicate(app.captureCharFrame())
      })
      return app.captureCharFrame()
    },
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      await Promise.all(disposals)
    },
  }
}

test("typing sol into the mounted palette renders the saved favorite above free and newer models", async () => {
  await using tmp = await tmpdir()
  await writeJsonAtomic(path.join(tmp.path, "model.json"), { favorite: [favorite], recent: [], variant: {} })
  await using view = await mount(tmp.path)
  await view.app.mockInput.typeText("sol")
  const frame = await view.frame((frame) => frame.includes("(Favorite)") && frame.includes("Sol Free"))
  expect(frame.indexOf("GPT 6 Sol")).toBeLessThan(frame.indexOf("Sol Free"))
  expect(frame.indexOf("GPT 6 Sol")).toBeLessThan(frame.indexOf("GPT 6.1 Sol"))
})

test("immediate picker teardown flushes pinned session changes without losing existing pins", async () => {
  await using tmp = await tmpdir()
  await writeJsonAtomic(path.join(tmp.path, "session.json"), { pinned: ["existing"] })
  const view = await mount(tmp.path)
  view.local().session.togglePin("added")
  view.local().session.togglePin("discard")
  view.local().session.togglePin("discard")
  await view[Symbol.asyncDispose]()
  expect((await Bun.file(path.join(tmp.path, "session.json")).json()).pinned).toEqual(["existing", "added"])
})

test("a filtered mounted palette promotes a favorite added by another instance", async () => {
  await using tmp = await tmpdir()
  await writeJsonAtomic(path.join(tmp.path, "model.json"), { favorite: [], recent: [], variant: {} })
  await using view = await mount(tmp.path)
  await view.app.mockInput.typeText("sol")
  const before = await view.frame((frame) => frame.includes("Sol Free") && frame.includes("GPT 6 Sol"))
  expect(before.indexOf("Sol Free")).toBeLessThan(before.indexOf("GPT 6 Sol"))
  const newer = createModelState({
    file: path.join(tmp.path, "model.json"),
    favorites: ModelFavorites.store({ database: path.join(tmp.path, "opencode.db"), state: tmp.path }),
    onChange() {},
    onError(error) {
      throw error
    },
  })
  await newer.ready
  await newer.setFavorite(favorite, true)
  await newer.dispose()
  const after = await view.frame((frame) => frame.includes("(Favorite)"))
  expect(after.indexOf("GPT 6 Sol")).toBeLessThan(after.indexOf("Sol Free"))
  expect(after.indexOf("GPT 6 Sol")).toBeLessThan(after.indexOf("GPT 6.1 Sol"))
})

test("favoriting a Sol result with ctrl+f persists it and moves it to the top", async () => {
  await using tmp = await tmpdir()
  await writeJsonAtomic(path.join(tmp.path, "model.json"), { favorite: [], recent: [], variant: {} })
  await using view = await mount(tmp.path)
  await view.app.mockInput.typeText("sol")
  await view.frame((frame) => frame.includes("Sol Free") && frame.includes("GPT 6 Sol"))
  view.app.mockInput.pressArrow("down")
  view.app.mockInput.pressArrow("down")
  view.app.mockInput.pressKey("f", { ctrl: true })
  const frame = await view.frame((frame) => frame.includes("(Favorite)"))
  const favorites = ModelFavorites.store({ database: path.join(tmp.path, "opencode.db"), state: tmp.path })
  await wait(async () => (await favorites.list()).length === 1)
  const saved = await favorites.list()
  const selected = providers.find((item) => item.id === saved[0]?.providerID)!
  const title = selected.models[saved[0]!.modelID]!.name
  expect(saved).toHaveLength(1)
  providers
    .filter((provider) => provider.id !== selected.id)
    .forEach((provider) => {
      expect(frame.indexOf(title)).toBeLessThan(frame.indexOf(Object.values(provider.models)[0]!.name))
    })
  await favorites.dispose()
})

test("a reopened palette keeps its favorites after an old process saves an empty favorite snapshot", async () => {
  await using tmp = await tmpdir()
  await writeJsonAtomic(path.join(tmp.path, "model.json"), { favorite: [favorite], recent: [], variant: {} })
  {
    await using original = await mount(tmp.path)
    await original.app.mockInput.typeText("sol")
    await original.frame((frame) => frame.includes("(Favorite)"))
  }

  await writeJsonAtomic(path.join(tmp.path, "model.json"), { favorite: [], recent: [], variant: {} })
  await using reopened = await mount(tmp.path)
  await reopened.app.mockInput.typeText("sol")
  const frame = await reopened.frame((frame) => frame.includes("(Favorite)") && frame.includes("Sol Free"))
  expect(frame.indexOf("GPT 6 Sol")).toBeLessThan(frame.indexOf("Sol Free"))
  expect(frame.indexOf("GPT 6 Sol")).toBeLessThan(frame.indexOf("GPT 6.1 Sol"))
})

import { CliRenderEvents, RGBA, SyntaxStyle, rgbToHex, type TerminalColors } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import {
  DEFAULT_THEMES,
  addTheme,
  allThemes,
  generateSubtleSyntax,
  generateSyntax,
  generateSystem,
  hasTheme,
  isTheme,
  resolveTheme,
  selectedForeground,
  setCustomThemes,
  setSystemTheme,
  subscribeThemes,
  terminalMode,
  tint,
  upsertTheme,
  type ThemeJson,
} from "../theme"
import { createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useKV } from "./kv"
import { useTuiConfig } from "../config"
import { Global } from "@opencode-ai/core/global"
import { Glob } from "@opencode-ai/core/util/glob"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { cacheStartupPresentation } from "../startup/cache"
import { useTuiPaths, useTuiStartup } from "./runtime"

export type ThemeSource = Readonly<{
  discover(): Promise<Record<string, unknown>>
  subscribeRefresh?(refresh: () => void): () => void
}>

const themeSource: ThemeSource = {
  async discover() {
    const directories = [Global.Path.config]
    for (let current = process.cwd(); ; current = path.dirname(current)) {
      directories.push(path.join(current, ".opencode"))
      if (path.dirname(current) === current) break
    }
    return discoverThemes(directories)
  },
  subscribeRefresh(refresh) {
    process.on("SIGUSR2", refresh)
    return () => process.off("SIGUSR2", refresh)
  },
}

export async function discoverThemes(directories: string[]) {
  const result: Record<string, unknown> = {}
  for (const directory of directories) {
    const files = await Glob.scan("themes/*.json", { cwd: directory, absolute: true, dot: true, symlink: true })
    for (const file of files) {
      result[path.basename(file, ".json")] = JSON.parse(await readFile(file, "utf8")) as unknown
    }
  }
  return result
}

export {
  DEFAULT_THEMES,
  addTheme,
  allThemes,
  generateSubtleSyntax,
  generateSyntax,
  generateSystem,
  hasTheme,
  isTheme,
  resolveTheme,
  selectedForeground,
  terminalMode,
  tint,
  upsertTheme,
  type Theme,
  type ThemeJson,
  type SyntaxStyleOverrides,
} from "../theme"

const THEME_REFRESH_DELAYS = [250, 1000] as const

type State = {
  themes: Record<string, ThemeJson>
  mode: "dark" | "light"
  lock: "dark" | "light" | undefined
  active: string
  ready: boolean
}

const [store, setStore] = createStore<State>({
  themes: allThemes(),
  mode: "dark",
  lock: undefined,
  active: "opencode",
  ready: false,
})

subscribeThemes((themes) => setStore("themes", themes))

export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: (props: { mode: "dark" | "light"; source?: ThemeSource }) => {
    const renderer = useRenderer()
    const config = useTuiConfig()
    const kv = useKV()
    const paths = useTuiPaths()
    const themes = props.source ?? themeSource
    const pick = (value: unknown) => {
      if (value === "dark" || value === "light") return value
      return
    }

    setStore(
      produce((draft) => {
        const lock = pick(kv.get("theme_mode_lock"))
        const mode = lock ?? pick(renderer.themeMode) ?? props.mode
        if (!lock && pick(kv.get("theme_mode")) !== undefined) kv.set("theme_mode", undefined)
        draft.mode = mode
        draft.lock = lock
        const active = config.theme ?? kv.get("theme", "opencode")
        draft.active = typeof active === "string" ? active : "opencode"
        draft.ready = false
      }),
    )

    createEffect(() => {
      const theme = config.theme
      if (theme) setStore("active", theme)
    })

    function syncCustomThemes() {
      return themes
        .discover()
        .then((themes) => {
          setCustomThemes(
            Object.entries(themes).reduce<Record<string, ThemeJson>>((result, [name, theme]) => {
              if (isTheme(theme)) result[name] = theme
              return result
            }, {}),
          )
        })
        .catch(() => {
          if (store.active !== "system") setStore("active", "opencode")
        })
    }

    onMount(() => {
      void Promise.allSettled([resolveSystemTheme(store.mode), syncCustomThemes()]).finally(() => {
        setStore("ready", true)
      })
    })

    let systemThemeSignature: string | undefined
    let systemThemeMode: "dark" | "light" | undefined
    function applySystemTheme(colors: TerminalColors, mode: "dark" | "light" = store.mode) {
      // A timeout can return an incomplete palette. Keep the selected system
      // theme (and its transparent background) until usable colors arrive.
      if (!colors.defaultBackground && !colors.palette[0]) return
      if (!colors.defaultForeground && !colors.palette[7]) return
      const next = store.lock ?? terminalMode(colors) ?? mode
      if (store.mode !== next) setStore("mode", next)
      const signature = JSON.stringify(colors)
      if (store.themes.system && systemThemeSignature === signature && systemThemeMode === next) return
      systemThemeSignature = signature
      systemThemeMode = next
      setSystemTheme(generateSystem(colors, next))
    }
    function resolveSystemTheme(mode: "dark" | "light" = store.mode) {
      return renderer
        .getPalette({ size: 16 })
        .then((colors) => applySystemTheme(colors, mode))
        .catch(() => {})
    }

    let systemRefreshRunning = false
    let systemRefreshQueued = false
    let systemRefreshMode = store.mode
    function refreshSystemTheme(mode: "dark" | "light" = store.mode) {
      systemRefreshMode = mode
      if (systemRefreshRunning) {
        systemRefreshQueued = true
        return
      }

      systemRefreshRunning = true
      const retry = renderer.paletteDetectionStatus === "detecting"
      renderer.clearPaletteCache()
      void resolveSystemTheme(mode).finally(() => {
        systemRefreshRunning = false
        if (!retry && !systemRefreshQueued) return
        systemRefreshQueued = false
        refreshSystemTheme(systemRefreshMode)
      })
    }

    function apply(mode: "dark" | "light") {
      if (store.lock !== undefined) kv.set("theme_mode", mode)
      if (store.mode === mode) return
      setStore("mode", mode)
      refreshSystemTheme(mode)
    }

    function pin(mode: "dark" | "light" = store.mode) {
      setStore("lock", mode)
      kv.set("theme_mode_lock", mode)
      apply(mode)
    }

    function free() {
      setStore("lock", undefined)
      kv.set("theme_mode_lock", undefined)
      kv.set("theme_mode", undefined)
      refreshSystemTheme(renderer.themeMode ?? store.mode)
    }

    const handle = (mode: "dark" | "light") => {
      if (store.lock) return
      apply(mode)
    }
    renderer.on(CliRenderEvents.THEME_MODE, handle)
    const palette = (colors: TerminalColors) => applySystemTheme(colors)
    renderer.on(CliRenderEvents.PALETTE, palette)

    const handleThemeNotification = (sequence: string) => {
      if (sequence !== "\x1b[?997;1n" && sequence !== "\x1b[?997;2n") return false
      queueMicrotask(() => refreshSystemTheme())
      return false
    }
    renderer.prependInputHandler(handleThemeNotification)

    let themeRefreshTimeouts: ReturnType<typeof setTimeout>[] = []
    const refresh = () => {
      for (const timeout of themeRefreshTimeouts) clearTimeout(timeout)
      themeRefreshTimeouts = THEME_REFRESH_DELAYS.map((delay) =>
        setTimeout(() => {
          refreshSystemTheme()
          if (delay === THEME_REFRESH_DELAYS[THEME_REFRESH_DELAYS.length - 1]) void syncCustomThemes()
        }, delay),
      )
    }
    let unsubscribeRefresh: (() => void) | undefined
    unsubscribeRefresh = themes.subscribeRefresh?.(refresh)

    onCleanup(() => {
      renderer.off(CliRenderEvents.THEME_MODE, handle)
      renderer.off(CliRenderEvents.PALETTE, palette)
      renderer.removeInputHandler(handleThemeNotification)
      unsubscribeRefresh?.()
      for (const timeout of themeRefreshTimeouts) clearTimeout(timeout)
      themeRefreshTimeouts.length = 0
    })

    const startup = useTuiStartup().earlyInput?.presentation
    const resolved = createMemo(() => {
      const active = store.themes[store.active]
      if (active) return resolveTheme(active, store.mode)
      if (store.active === "system")
        return { ...resolveTheme(store.themes.opencode, store.mode), background: RGBA.fromInts(0, 0, 0, 0) }

      const saved = kv.get("theme")
      if (typeof saved === "string") {
        const theme = store.themes[saved]
        if (theme) return resolveTheme(theme, store.mode)
      }

      return resolveTheme(store.themes.opencode, store.mode)
    })

    // Custom and terminal-derived themes resolve asynchronously. Preserve the
    // startup colors instead of painting the default theme beneath the preview.
    // System mode also retains them after a palette timeout, until usable colors
    // arrive; theme readiness must not turn terminal transparency into black.
    const values = createMemo(() => {
      if (!startup || (store.ready && (store.active !== "system" || store.themes.system))) return resolved()
      const color = (value: string) => (value === "transparent" ? RGBA.fromInts(0, 0, 0, 0) : RGBA.fromHex(value))
      return {
        ...resolved(),
        background: store.active === "system" ? RGBA.fromInts(0, 0, 0, 0) : color(startup.background),
        backgroundElement: color(startup.backgroundElement),
        text: color(startup.text),
        textMuted: color(startup.textMuted),
      }
    })

    // Palette discovery changes the RGB snapshot behind a transparent color,
    // not the terminal's visible background. OpenTUI's setter clears its buffer
    // and repaints the whole screen, so only call it for a visible color change.
    const background = createMemo(() => values().background, undefined, {
      equals: (previous, next) => (previous?.a === 0 && next.a === 0) || next.equals(previous),
    })
    createEffect(() => renderer.setBackgroundColor(background()))
    createEffect(() => {
      if (!store.ready) return
      const theme = values()
      cacheStartupPresentation(paths.state, {
        background: theme.background.a === 0 ? "transparent" : rgbToHex(theme.background),
        backgroundElement: theme.backgroundElement.a === 0 ? "transparent" : rgbToHex(theme.backgroundElement),
        text: rgbToHex(theme.text),
        textMuted: rgbToHex(theme.textMuted),
        menuBorder: rgbToHex(theme.border),
        backgroundMenu: theme.backgroundMenu.a === 0 ? "transparent" : rgbToHex(theme.backgroundMenu),
        primary: rgbToHex(theme.primary),
        selectedText: rgbToHex(selectedForeground(theme)),
        warning: rgbToHex(theme.warning),
        mouse: config.mouse,
        inputBindings: {
          submit: config.keybinds
            .get("input.submit")
            .flatMap((binding) => (typeof binding.key === "string" ? binding.key.split(",") : [])),
          newline: config.keybinds
            .get("input.newline")
            .flatMap((binding) => (typeof binding.key === "string" ? binding.key.split(",") : [])),
        },
        maxWidth: config.prompt?.max_width ?? 75,
        maxHeight: config.prompt?.max_height ?? 0,
        cursorStyle: config.cursor?.style ?? "block",
        cursorBlinking: config.cursor?.blinking ?? true,
      })
    })

    const syntax = createSyntaxStyleMemo(() => generateSyntax(values()))
    const subtleSyntax = createSyntaxStyleMemo(() => generateSubtleSyntax(values()))

    return {
      theme: new Proxy(values(), {
        get(_target, prop) {
          // @ts-expect-error Properties are forwarded to the current reactive value.
          return values()[prop]
        },
      }),
      get selected() {
        return store.active
      },
      all: allThemes,
      has: hasTheme,
      syntax,
      subtleSyntax,
      mode: () => store.mode,
      locked: () => store.lock !== undefined,
      lock: () => pin(store.mode),
      unlock: free,
      setMode: pin,
      set(theme: string) {
        if (!hasTheme(theme)) return false
        setStore("active", theme)
        kv.set("theme", theme)
        return true
      },
      get ready() {
        return store.ready
      },
    }
  },
})

export function createSyntaxStyleMemo(factory: () => SyntaxStyle) {
  const renderer = useRenderer()
  const retained = new Set<SyntaxStyle>()
  let current: SyntaxStyle | undefined

  const release = (style: SyntaxStyle) => {
    retained.add(style)
    void renderer
      .idle()
      .catch(() => {})
      .finally(() => {
        if (!retained.delete(style)) return
        style.destroy()
      })
  }

  onCleanup(() => {
    if (current) release(current)
  })

  return createMemo(() => {
    const previous = current
    current = factory()
    if (previous) release(previous)
    return current
  })
}

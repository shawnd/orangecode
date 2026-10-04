import { createComponent, createContext, type JSX, useContext } from "solid-js"
import type { StartupPresentation } from "../startup/presentation"
import type { StartupSlashDraft, StartupSlashMenu } from "../startup/slashes"
import type { StartupControlTarget } from "../startup/controls"
import { ShutdownProvider } from "./shutdown"

export type TuiPaths = Readonly<{
  cwd: string
  home: string
  state: string
  database?: string
  worktree: string
}>

export type TuiTerminalEnvironment = Readonly<{
  platform: string
  multiplexer?: "tmux" | "screen"
  displayServer?: "wayland" | "x11"
}>

export type TuiStartup = Readonly<{
  initialRoute?: unknown
  skipInitialLoading: boolean
  earlyInput?: EarlyInput
}>

// A structural boundary keeps the terminal bootstrap independent of the TUI's
// runtime dependency graph. Cursor positions here are UTF-16 string offsets.
export type EarlyInput = {
  readonly active: boolean
  readonly modal?: boolean
  readonly presentation?: StartupPresentation
  readonly location?: { directory: string; displayDirectory: string; version: string; auto: boolean }
  read(): StartupSlashDraft
  completion?(height?: number): StartupSlashMenu
  selectCompletion?(index: number): void
  highlightCompletion?(index: number): void
  clickSelection?(target: StartupControlTarget | "provider", direction?: 1 | -1): void
  openModal?(): void
  closeModal?(): void
  selectModel?(providerID: string, modelID: string): void
  subscribe(listener: () => void): () => void
  takeover(): Promise<NodeJS.ReadStream>
  redraw?(): void
  onCancel(shutdown: () => void): void
  claim(): StartupSlashDraft | undefined
  dispose(): void
}

const PathsContext = createContext<TuiPaths>()
const TerminalEnvironmentContext = createContext<TuiTerminalEnvironment>()
const StartupContext = createContext<TuiStartup>()

function provider<T>(context: ReturnType<typeof createContext<T>>, value: T, children: () => JSX.Element) {
  return createComponent(context.Provider, {
    value: Object.freeze({ ...value }),
    get children() {
      return children()
    },
  })
}

export function TuiPathsProvider(props: {
  value: TuiPaths
  children: JSX.Element
  onDispose?: (done: Promise<void>) => void
}) {
  if (props.onDispose)
    return createComponent(ShutdownProvider, {
      track: props.onDispose,
      get children() {
        return provider(PathsContext, props.value, () => props.children)
      },
    })
  return provider(PathsContext, props.value, () => props.children)
}

export function TuiTerminalEnvironmentProvider(props: { value: TuiTerminalEnvironment; children: JSX.Element }) {
  return provider(TerminalEnvironmentContext, props.value, () => props.children)
}

export function TuiStartupProvider(props: { value: TuiStartup; children: JSX.Element }) {
  return provider(StartupContext, props.value, () => props.children)
}

function required<T>(context: ReturnType<typeof createContext<T>>, name: string) {
  const value = useContext(context)
  if (!value) throw new Error(`${name} is missing`)
  return value
}

export function useTuiPaths() {
  return required(PathsContext, "TuiPathsProvider")
}

export function useTuiTerminalEnvironment() {
  return required(TerminalEnvironmentContext, "TuiTerminalEnvironmentProvider")
}

export function useTuiStartup() {
  return required(StartupContext, "TuiStartupProvider")
}

/** @jsxImportSource @opentui/solid */
import {
  TuiPathsProvider,
  TuiStartupProvider,
  TuiTerminalEnvironmentProvider,
  type TuiPaths,
} from "../../src/context/runtime"
import type { ParentProps } from "solid-js"
import path from "path"

export function TestTuiContexts(
  props: ParentProps<{
    cwd?: string
    directory?: string
    paths?: Partial<TuiPaths>
    onDispose?: (done: Promise<void>) => void
  }>,
) {
  return (
    <TuiPathsProvider
      onDispose={props.onDispose}
      value={{
        cwd: props.cwd ?? props.directory ?? "/tmp/opencode/packages/tui",
        home: "/tmp/opencode/home",
        state: "/tmp/opencode/state",
        database: path.join(props.paths?.state ?? "/tmp/opencode/state", "opencode.db"),
        worktree: "/tmp/opencode",
        ...props.paths,
      }}
    >
      <TuiTerminalEnvironmentProvider value={{ platform: "linux" }}>
        <TuiStartupProvider value={{ skipInitialLoading: false }}>{props.children}</TuiStartupProvider>
      </TuiTerminalEnvironmentProvider>
    </TuiPathsProvider>
  )
}

import { createResource, Show } from "solid-js"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { gitCheckout } from "../util/git-checkout"

export function GitStatus(props: { directory: string; separator?: boolean }) {
  const sync = useSync()
  const { theme } = useTheme()
  const [checkout] = createResource(
    () => [props.directory, sync.path.directory, sync.data.vcs?.branch] as const,
    async ([directory]) => ({ directory, info: await gitCheckout(directory).catch(() => undefined) }),
  )
  const label = () => {
    const result = checkout()
    const local = result?.directory === props.directory ? result.info : undefined
    const branch = props.directory === sync.path.directory ? (sync.data.vcs?.branch ?? local?.branch) : local?.branch
    if (!branch) return
    return local?.linked ? `worktree: ${branch}` : `${branch}`
  }

  return (
    <Show when={label()}>
      {(value) => (
        <text fg={theme.textMuted} wrapMode="none" truncate maxWidth={28}>
          <Show when={props.separator}>· </Show>
          {value()}
        </text>
      )}
    </Show>
  )
}

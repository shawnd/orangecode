import { createSimpleContext } from "./helper"

export type Restart = { sessionID?: string; directory?: string }

export type Exit = (reason?: unknown, restart?: Restart) => void

export const { use: useExit, provider: ExitProvider } = createSimpleContext({
  name: "Exit",
  init: (input: { exit: Exit }) => input.exit,
})

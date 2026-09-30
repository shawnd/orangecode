import type { Argv, CommandModule } from "yargs"

class LoadCommand {
  constructor(readonly load: () => Promise<void>) {}
}

/** Keep builders synchronous: yargs completion does not await async builders. */
export function lazyCommand<T, U>(
  metadata: Pick<CommandModule<T, U>, "command" | "describe" | "aliases">,
  load: () => Promise<CommandModule<T, U>>,
) {
  let command: CommandModule<T, U> | undefined
  return (cli: Argv<T>) =>
    cli.command(
      command ?? {
        ...metadata,
        builder: () => {
          // Abort before validation, middleware or handlers. Retry with a fresh
          // parser because yargs mutates its command context before this call.
          throw new LoadCommand(async () => {
            command = await load()
          })
        },
        handler: () => {},
      },
    )
}

export async function parseCommands(parse: () => unknown) {
  while (true) {
    try {
      return await parse()
    } catch (error) {
      if (!(error instanceof LoadCommand)) throw error
      await error.load()
    }
  }
}

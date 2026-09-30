import { expect, test } from "bun:test"
import yargs from "yargs"
import { lazyCommand, parseCommands } from "../../src/cli/lazy"

test("imports only the selected command and executes middleware once", async () => {
  const calls: string[] = []
  const selected = lazyCommand({ command: "run <message>", aliases: ["r"] }, async () => {
    calls.push("load")
    return {
      command: "run <message>",
      aliases: ["r"],
      builder: (cli) => cli.positional("message", { type: "string" }).option("model", { type: "string" }),
      handler: (args) => {
        expect(args.message).toBe("hello")
        expect(args.model).toBe("unused")
        expect(args["--"]).toEqual(["unused", "--help"])
        calls.push("handler")
      },
    }
  })
  const unused = lazyCommand({ command: "unused" }, async () => {
    throw new Error("unselected command imported")
  })
  await parseCommands(() => {
    const cli = yargs(["--pure", "r", "hello", "--model", "unused", "--", "unused", "--help"])
      .parserConfiguration({ "populate--": true })
      .option("pure", { type: "boolean" })
      .middleware((args) => {
        expect(args.pure).toBe(true)
        calls.push("middleware")
      })
      .exitProcess(false)
      .strict()
    unused(cli)
    selected(cli)
    return cli.parseAsync()
  })
  expect(calls).toEqual(["load", "middleware", "handler"])
})

test.each([
  [[], undefined, undefined],
  [["somewhere"], "somewhere", undefined],
  [["--prompt", "run"], undefined, "run"],
  [["--", "run"], undefined, undefined],
] as const)("preserves default dispatch for %j", async (args, project, prompt) => {
  const calls: unknown[] = []
  const selected = lazyCommand({ command: "$0 [project]" }, async () => ({
    command: "$0 [project]",
    builder: (cli) => cli.positional("project", { type: "string" }).option("prompt", { type: "string" }),
    handler: (args) => {
      calls.push([args.project, args.prompt])
    },
  }))
  const unused = lazyCommand({ command: "run" }, async () => {
    throw new Error("option values are not commands")
  })
  await parseCommands(() => {
    const cli = yargs([...args])
      .parserConfiguration({ "populate--": true })
      .exitProcess(false)
      .strict()
    selected(cli)
    unused(cli)
    return cli.parseAsync()
  })
  expect(calls).toEqual([[project, prompt]])
})

test("nested completion loads synchronous builders without invoking handlers", async () => {
  const calls: string[] = []
  const register = lazyCommand({ command: "parent" }, async () => {
    calls.push("load")
    return {
      command: "parent",
      builder: (cli) =>
        cli.command({
          command: "child",
          builder: (cli) => cli.option("mode", { type: "string", choices: ["a", "b"] }),
          handler: () => {
            calls.push("handler")
          },
        }),
      handler: () => {},
    }
  })
  const output: string[] = []
  const args = ["--get-yargs-completions", "test", "parent", "child", "--"]
  await parseCommands(() => {
    const cli = yargs(args).scriptName("test").exitProcess(false).completion()
    register(cli)
    return cli.parseAsync(args, (error: Error | undefined, _argv: unknown, text: string) => {
      if (error) throw error
      output.push(text)
    })
  })
  expect(output.join("\n")).toContain("--mode")
  expect(calls).toEqual(["load"])
})

test("propagates module and handler failures without retrying", async () => {
  const error = new Error("failed")
  for (const phase of ["load", "handler"]) {
    const calls: string[] = []
    const register = lazyCommand({ command: "run" }, async () => {
      calls.push("load")
      if (phase === "load") throw error
      return {
        command: "run",
        handler: async () => {
          calls.push("handler")
          throw error
        },
      }
    })
    await expect(
      parseCommands(() => {
        const cli = yargs(["run"])
          .exitProcess(false)
          .fail((_message, error) => {
            throw error
          })
        register(cli)
        return cli.parseAsync()
      }),
    ).rejects.toBe(error)
    expect(calls).toEqual(phase === "load" ? ["load"] : ["load", "handler"])
  }
})

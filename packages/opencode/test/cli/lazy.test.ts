import { describe, expect, test } from "bun:test"
import yargs from "yargs"
import { lazyCommand, parseCommands } from "../../src/cli/lazy"

describe("lazy command registration", () => {
  test("loads only the selected command and runs middleware and handler once", async () => {
    const events: string[] = []
    const selected = lazyCommand({ command: "run <message>", aliases: ["r"] }, async () => {
      events.push("load")
      return {
        command: "run <message>",
        aliases: ["r"],
        builder: (cli) => cli.positional("message", { type: "string" }).option("model", { type: "string" }),
        handler: (args) => {
          events.push("handler")
          expect(args.message).toBe("hello")
          expect(args.model).toBe("unused")
          expect(args["--"]).toEqual(["unused", "--help"])
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
          events.push("middleware")
        })
        .exitProcess(false)
        .strict()
      unused(cli)
      selected(cli)
      return cli.parseAsync()
    })
    expect(events).toEqual(["load", "middleware", "handler"])
  })

  test.each([
    [[], undefined, undefined],
    [["somewhere"], "somewhere", undefined],
    [["--prompt", "run"], undefined, "run"],
    [["--", "run"], undefined, undefined],
  ] as const)("preserves default dispatch for %j", async (args, project, prompt) => {
    const calls: unknown[] = []
    const register = lazyCommand({ command: "$0 [project]" }, async () => ({
      command: "$0 [project]",
      builder: (cli) => cli.positional("project", { type: "string" }).option("prompt", { type: "string" }),
      handler: (argv) => {
        calls.push([argv.project, argv.prompt])
      },
    }))
    const unused = lazyCommand({ command: "run" }, async () => {
      throw new Error("option values and double-dash arguments are not commands")
    })
    await parseCommands(() => {
      const cli = yargs([...args])
        .parserConfiguration({ "populate--": true })
        .exitProcess(false)
        .strict()
      register(cli)
      unused(cli)
      return cli.parseAsync()
    })
    expect(calls).toEqual([[project, prompt]])
  })

  test("uses the original nested builder for help and validation", async () => {
    const events: string[] = []
    const register = lazyCommand({ command: "parent", aliases: ["p"] }, async () => ({
      command: "parent",
      aliases: ["p"],
      builder: (cli) =>
        cli
          .command({
            command: "child <value>",
            builder: (cli) => cli.positional("value", { type: "string" }).option("mode", { choices: ["a", "b"] }),
            handler: () => {
              events.push("handler")
            },
          })
          .demandCommand(),
      handler: () => {},
    }))
    const output: string[] = []
    const args = ["p", "child", "--help"]
    await parseCommands(() => {
      const cli = yargs(args).scriptName("test").help().exitProcess(false).strict()
      register(cli)
      return cli.parseAsync(args, (error: Error | undefined, _argv: unknown, text: string) => {
        if (error) throw error
        output.push(text)
      })
    })
    expect(output).toHaveLength(1)
    expect(output[0]).toContain("child <value>")
    expect(output[0]).toContain("--mode")
    expect(events).toEqual([])

    await expect(
      parseCommands(() => {
        const cli = yargs(["p", "child"])
          .exitProcess(false)
          .strict()
          .fail((message, error) => {
            throw error ?? new Error(message)
          })
        register(cli)
        return cli.parseAsync()
      }),
    ).rejects.toThrow("Not enough non-option arguments")
    expect(events).toEqual([])
  })

  test("loads synchronous builders during nested completion without invoking handlers", async () => {
    const events: string[] = []
    const register = lazyCommand({ command: "parent" }, async () => {
      events.push("load")
      return {
        command: "parent",
        builder: (cli) =>
          cli.command({
            command: "child",
            builder: (cli) => cli.option("mode", { type: "string", choices: ["a", "b"] }),
            handler: () => {
              events.push("handler")
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
    expect(events).toEqual(["load"])
  })

  test("propagates module load errors and handler failures without retrying", async () => {
    const error = new Error("failed")
    for (const phase of ["load", "handler"]) {
      const events: string[] = []
      const register = lazyCommand({ command: "run" }, async () => {
        events.push("load")
        if (phase === "load") throw error
        return {
          command: "run",
          handler: async () => {
            events.push("handler")
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
      expect(events).toEqual(phase === "load" ? ["load"] : ["load", "handler"])
    }
  })
})

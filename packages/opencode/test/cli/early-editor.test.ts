import { describe, expect, test } from "bun:test"
import { createEarlyEditor } from "../../src/cli/early-editor"
import { canStartEarlyInput } from "../../src/cli/early-input"
import { builtinStartupSlashes, createStartupSlashes } from "@opencode-ai/tui/startup/slashes"

const bytes = (value: string) => new TextEncoder().encode(value)

describe("early input", () => {
  test("cached submit/newline bindings honor modified Enter and custom input keys", () => {
    const editor = createEarlyEditor()
    editor.feed(bytes("one\x1b[13;2utwo\x1b[13;5uthree\x1b\rfour\nend"))
    expect(editor.state.text).toBe("one\ntwo\nthree\nfour\nend")
    expect(editor.state.submit).toBeUndefined()
    editor.feed(bytes("\r"))
    expect(editor.state.submit).toBe(true)
    editor.feed(bytes("\x15"))
    expect(editor.state.submit).toBeUndefined()
    const modified = bytes("one\x1b[27;2;13~two\x1b[27;5;13~three\x1b[27;3;13~end")
    for (let split = 0; split <= modified.length; split++) {
      const before = createEarlyEditor()
      before.feed(modified.slice(0, split))
      const after = createEarlyEditor(structuredClone(before.state))
      after.feed(modified.slice(split))
      expect(after.state.text).toBe("one\ntwo\nthree\nend")
      expect(after.state.submit).toBeUndefined()
    }
    const custom = createEarlyEditor(undefined, undefined, undefined, { submit: ["ctrl+s"], newline: ["enter"] })
    custom.feed(bytes("one\rtwo\x13"))
    expect(custom.state.text).toBe("one\ntwo")
    expect(custom.state.submit).toBe(true)
  })
  test("slash commands filter aliases, navigate and explicitly defer UI selection without submitting", () => {
    const slashes = createStartupSlashes(builtinStartupSlashes())
    const editor = createEarlyEditor(undefined, undefined, slashes.key)
    editor.feed(bytes("/"))
    expect(slashes.view(editor.state)?.options[0]?.display.trimEnd()).toBe("/agents")
    editor.feed(bytes("\x1b[B"))
    expect(editor.state.slash?.selected).toBe("/connect")
    editor.feed(bytes("\x10"))
    expect(editor.state.slash?.selected).toBe("/agents")
    editor.feed(bytes("mo\r"))
    expect(editor.state.text).toBe("/models ")
    expect(editor.state.command).toEqual({ name: "model.list", display: "/models", prefix: "/models " })
    expect(slashes.view(editor.state)).toBeUndefined()
    editor.feed(bytes("\x1b"))
    editor.escape()
    expect(editor.state.text).toBe("")
    expect(editor.state.command).toBeUndefined()
    editor.feed(bytes("/mo\r"))
    editor.feed(bytes("\x15hello\nworld"))
    slashes.view(editor.state)
    expect(editor.state.command).toBeUndefined()
    expect(editor.state.text).toBe("hello\nworld")
  })

  test("server slash completion only inserts a command and survives fragmented handoff", () => {
    const items = [{ display: "/review:mcp", value: "/review", description: "Review changes" }]
    const input = bytes("/rev\x1b[B\targuments")
    for (let split = 0; split <= input.length; split++) {
      const slashes = createStartupSlashes(items)
      const before = createEarlyEditor(undefined, undefined, slashes.key)
      before.feed(input.slice(0, split))
      const next = createStartupSlashes(items)
      const after = createEarlyEditor(structuredClone(before.state), undefined, next.key)
      after.feed(input.slice(split))
      expect(after.state.text).toBe("/review arguments")
      expect(after.state.command).toBeUndefined()
      expect(after.settled).toBe(true)
    }
  })

  test("paste and Shift-Enter remain text; Escape dismisses the same way as live autocomplete", () => {
    const slashes = createStartupSlashes(builtinStartupSlashes())
    const editor = createEarlyEditor(undefined, undefined, slashes.key)
    editor.feed(bytes("\x1b[200~/models\r\nkeep typing\x1b[201~"))
    expect(editor.state.text).toBe("/models\nkeep typing")
    expect(editor.state.command).toBeUndefined()
    editor.feed(bytes("\x15/mo\x1b[13;2u"))
    expect(editor.state.text).toBe("/mo\n")
    expect(editor.state.command).toBeUndefined()
    editor.feed(bytes("\x15/mo\x1b"))
    editor.escape()
    expect(editor.state.text).toBe("")
    expect(editor.settled).toBe(true)
  })

  test("SGR mouse events reach the renderer without changing the startup draft", () => {
    const replies: string[] = []
    const slashes = createStartupSlashes(builtinStartupSlashes())
    const editor = createEarlyEditor(undefined, (sequence) => replies.push(sequence), slashes.key)
    editor.feed(bytes("/mo\x1b[<0;28;18M\x1b[<0;28;18m"))
    expect(editor.state.text).toBe("/mo")
    expect(replies).toEqual(["\x1b[<0;28;18M", "\x1b[<0;28;18m"])
    expect(editor.feed(bytes("\x03"))).toBe("cancel")
  })
  test("only opts into unambiguous interactive local starts", () => {
    expect(canStartEarlyInput([], true, true, "linux")).toBe(true)
    expect(canStartEarlyInput(["--pure", "--auto"], true, true, "linux")).toBe(true)
    for (const args of [
      ["--help"],
      ["--version"],
      ["run"],
      ["attach"],
      ["--mini"],
      ["--prompt", "hello"],
      ["-c"],
      ["--unknown"],
    ]) {
      expect(canStartEarlyInput(args, true, true, "linux")).toBe(false)
    }
    expect(canStartEarlyInput([], false, true, "linux")).toBe(false)
    expect(canStartEarlyInput([], true, false, "linux")).toBe(false)
    expect(canStartEarlyInput([], true, true, "win32")).toBe(false)
  })

  test("explicit project paths work before or after safe flags without filesystem checks", () => {
    for (const project of [
      ".",
      "..",
      "./repo",
      "../repo",
      "/",
      "/tmp/nonexistent-project",
      "./repo with spaces",
      "/tmp/项目",
    ]) {
      expect(canStartEarlyInput([project], true, true, "linux")).toBe(true)
      expect(canStartEarlyInput(["--pure", project, "--auto"], true, true, "linux")).toBe(true)
      expect(canStartEarlyInput([project, "--pure", "--yolo"], true, true, "linux")).toBe(true)
      expect(canStartEarlyInput([project], false, true, "linux")).toBe(false)
      expect(canStartEarlyInput([project], true, false, "linux")).toBe(false)
    }
  })

  test("paths do not hide commands, invalid options, or unsupported resume modes", () => {
    for (const args of [
      ["repo"],
      ["run"],
      ["serve"],
      ["attach", "/tmp/repo"],
      [".", "../repo"],
      [""],
      [".", "--help"],
      ["--version", "/tmp/repo"],
      [".", "--mini"],
      [".", "-mini"],
      [".", "--prompt", "hello"],
      [".", "--prompt=hello"],
      [".", "--unknown"],
      ["--", "."],
      [".", "--continue"],
      ["-c", "./repo"],
      ["--session", "ses_example", "."],
      [".", "--session=ses_example"],
      ["-s", "ses_example", "."],
      [".", "-s=ses_example"],
      [".", "--session"],
      [".", "-s", "--help"],
    ]) {
      expect(canStartEarlyInput(args, true, true, "linux")).toBe(false)
    }
  })

  test("edits graphemes, not UTF-16 halves, and preserves a middle cursor", () => {
    const editor = createEarlyEditor()
    editor.feed(bytes("a👩‍💻é界z"))
    editor.feed(bytes("\x1b[D\x7f\x7f\x7f"))
    expect(editor.state.text).toBe("az")
    expect(editor.state.cursor).toBe(1)
    editor.feed(bytes("ø"))
    expect(editor.state.text).toBe("aøz")
  })

  test("Enter queues submission; Ctrl-J and modified Enter insert newlines like the live prompt", () => {
    const editor = createEarlyEditor()
    expect(editor.feed(bytes("\nfirst\nsecond"))).toBeUndefined()
    expect(editor.state.text).toBe("\nfirst\nsecond")
    editor.feed(bytes("\r"))
    expect(editor.state.submit).toBe(true)
    expect(editor.state.text).toBe("\nfirst\nsecond")
    editor.feed(bytes("\x1b"))
    editor.escape()
    expect(editor.state.submit).toBeUndefined()
    editor.feed(bytes("\x1b[A\x01X\x05Y"))
    expect(editor.state.text).toBe("\nXfirstY\nsecond")
    editor.feed(bytes("\x15\nA\x1b[A\x01"))
    expect(editor.state.cursor).toBe(0)
  })

  test("handoff carries split UTF-8, escape sequences and bracketed paste", () => {
    const input = bytes("ab👩‍💻\x1b[D界\x1b[200~one\r\ntwo\x03\x1b[201~\x1b[3~")
    for (let split = 0; split <= input.length; split++) {
      const before = createEarlyEditor()
      before.feed(input.slice(0, split))
      const after = createEarlyEditor(structuredClone(before.state))
      expect(after.feed(input.slice(split))).toBeUndefined()
      expect(after.state.text).toBe("ab界one\ntwo")
      expect(after.state.cursor).toBe("ab界one\ntwo".length)
      expect(after.settled).toBe(true)
    }
  })

  test("fragmented paste is not claimable and control bytes do not cancel", () => {
    const editor = createEarlyEditor()
    editor.feed(bytes("\x1b[200~hello\x03"))
    expect(editor.settled).toBe(false)
    expect(editor.feed(bytes("\x1b[201~"))).toBeUndefined()
    expect(editor.state.text).toBe("hello")
    expect(editor.settled).toBe(true)
    expect(editor.feed(bytes("\x03"))).toBe("cancel")
  })

  test("terminal replies do not become prompt text during takeover", () => {
    const editor = createEarlyEditor()
    editor.feed(bytes("hello\x1b[?1;2c\x1b]11;rgb:0000/0000/0000\x07\x1b[?997;1n"))
    expect(editor.state.text).toBe("hello")
    expect(editor.settled).toBe(true)
    editor.feed(bytes("\x1b[57350u\x1b[127u\x1b[33u\x1b[120;1:3u"))
    expect(editor.state.text).toBe("hel!o")
    expect(editor.feed(bytes("\x1b[99;5u"))).toBe("cancel")
  })

  test("Kitty shifted text and terminal version replies survive the renderer boundary", () => {
    const replies: string[] = []
    const editor = createEarlyEditor(undefined, (sequence) => replies.push(sequence))
    editor.feed(bytes("\x1b[97:65;2u\x1b[98:66:98;2u\x1bP>|terminal version\x1b\\"))
    expect(editor.state.text).toBe("AB")
    expect(replies).toEqual(["\x1bP>|terminal version\x1b\\"])
    editor.feed(bytes("\x1b\x1b[?997;1n"))
    expect(editor.state.text).toBe("AB")
    expect(editor.settled).toBe(true)
  })

  test("complete DECRPM replies reach the renderer across every input and handoff boundary", () => {
    const expected = ["\x1b[?1016;2$y", "\x1b[?2027;1$y", "\x1b[?2031;2$y"]
    const input = bytes("left" + expected.join("") + "right")
    for (let split = 0; split <= input.length; split++) {
      const replies: string[] = []
      const receive = (sequence: string) => {
        replies.push(sequence)
      }
      const before = createEarlyEditor(undefined, receive)
      before.feed(input.slice(0, split))
      const after = createEarlyEditor(structuredClone(before.state), receive)
      after.feed(input.slice(split))
      expect(replies).toEqual(expected)
      expect(after.state.text).toBe("leftright")
      expect(after.settled).toBe(true)
    }
    const replies: string[] = []
    const editor = createEarlyEditor(undefined, (sequence) => {
      replies.push(sequence)
    })
    editor.feed(bytes("\x1b[?1016;2y\x1b[1016;2$y"))
    expect(replies).toEqual([])
  })

  test("Escape can settle after handoff and malformed sequences remain cancellable", () => {
    const before = createEarlyEditor()
    before.feed(bytes("draft\x1b"))
    const after = createEarlyEditor(structuredClone(before.state))
    expect(after.settled).toBe(false)
    after.escape()
    expect(after.settled).toBe(true)
    expect(after.state.text).toBe("draft")
    after.feed(bytes("\x1b["))
    expect(after.feed(bytes("\x03"))).toBe("cancel")
  })
})

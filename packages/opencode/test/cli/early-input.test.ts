import { expect, test } from "bun:test"
import { tmpdir } from "node:os"

const supported = process.platform !== "win32" && Boolean(Bun.which("python3"))
const module = JSON.stringify(import.meta.resolve("../../src/cli/early-input"))
const rendererModule = JSON.stringify(import.meta.resolve("../../../tui/src/util/renderer"))
const effectModule = JSON.stringify(import.meta.resolve("effect"))
const coreModule = JSON.stringify(import.meta.resolve("@opentui/core"))

type Mode =
  | "handoff"
  | "exit"
  | "cancel"
  | "signal"
  | "hangup"
  | "resize"
  | "cached"
  | "slash"
  | "controls"
  | "modal-tail"
  | "modal-paste"
  | "modal-select"
  | `renderer-${"preclaim" | "claimed"}-${"SIGTERM" | "SIGINT" | "SIGHUP" | "ctrl-c"}`

// A real PTY verifies raw/cooked terminal state and two independent readers.
// No mocked stdin: the handoff regression is caused by actual stream ordering.
async function run(body: string, mode: Mode, args: string[] = [], setup = "") {
  const child = Bun.spawn(
    [
      "python3",
      "-c",
      `
import os, pty, select, signal, subprocess, sys, termios, time, json, fcntl, struct
master, slave = pty.openpty()
if sys.argv[3] in ["resize", "slash", "controls"]: fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
before = termios.tcgetattr(slave)
child = subprocess.Popen([sys.argv[1], "-e", sys.argv[2]], stdin=slave, stdout=slave, stderr=slave)
output = b""
sent = set()
deadline = time.monotonic() + 8
try:
    while time.monotonic() < deadline:
        if select.select([master], [], [], .01)[0]:
            output += os.read(master, 65536)
        if (b"Type now" in output or b"cached selection" in output) and "initial" not in sent:
            sent.add("initial")
            text = "ab👩‍💻界\\x1b[D\\x7fZ".encode()
            if sys.argv[3] == "slash": text = b"/mo"
            if sys.argv[3] == "controls":
                text = b"\\x1b[<0;55;23M\\x1b[<0;55;23m"
            if sys.argv[3].startswith("modal-"): text = b""
            if sys.argv[3] == "handoff": text += b"\\x1b[200~one"
            os.write(master, text)
        if sys.argv[3] == "slash" and b"/models" in output and "choose" not in sent:
            sent.add("choose")
            os.write(master, b"\\t")
        if sys.argv[3] == "controls" and b"\\x1b[1mhigh" in output and "model" not in sent:
            sent.add("model")
            os.write(master, b"\\x1b[<0;35;23M\\x1b[<0;35;23m")
        if sys.argv[3] == "controls" and b"Model B" in output and "reverse" not in sent:
            sent.add("reverse")
            os.write(master, b"\\x1b[<2;55;23M\\x1b[<2;55;23m")
        if b"MODEL_MODAL" in output and "modal" not in sent:
            sent.add("modal")
            if sys.argv[3] == "modal-tail": os.write(master, b"\\x1b[27uTAIL_MARK")
            if sys.argv[3] == "modal-paste":
                os.write(master, b"\\x1b[27u\\x1b[200~PASTE_MARK")
                time.sleep(.06)
                os.write(master, b"\\x1b[201~")
            if sys.argv[3] == "modal-select": os.write(master, b"\\x1b[13u")
        if "abZ界".encode() in output and "stop" not in sent:
            sent.add("stop")
            if sys.argv[3] == "cancel": os.write(master, b"\\x03")
            if sys.argv[3] == "signal": child.terminate()
            if sys.argv[3] == "resize": fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        if b"WAITING" in output and "paste" not in sent:
            sent.add("paste")
            os.write(master, b"\\r\\ntwo\\x1b[201~!")
        if b"CLAIMED" in output and "native" not in sent:
            sent.add("native")
            if sys.argv[3] == "hangup": child.send_signal(signal.SIGHUP)
            else: os.write(master, b"next")
        if b"RENDERER_READY" in output and "renderer" not in sent:
            sent.add("renderer")
            if sys.argv[3].endswith("-ctrl-c"): os.write(master, b"\\x03")
            else: child.send_signal(getattr(signal, sys.argv[3].split("-")[-1]))
        if child.poll() is not None:
            while select.select([master], [], [], .01)[0]: output += os.read(master, 65536)
            break
    print(json.dumps({"output": output.decode(errors="replace"), "code": child.poll(), "restored": before == termios.tcgetattr(slave)}))
finally:
    if child.poll() is None: child.kill()
    child.wait()
    os.close(master)
    os.close(slave)
`,
      process.execPath,
      `import { startEarlyInput, getEarlyInput, stopEarlyInput } from ${module};
       process.argv = [process.execPath, "early-input-test", ...${JSON.stringify(args)}];
        ${setup} startEarlyInput(); ${body}`,
      mode,
    ],
    {
      cwd: tmpdir(),
      env: {
        ...process.env,
        TERM: "xterm-256color",
        XDG_STATE_HOME: `${tmpdir()}/early-input-absent-${crypto.randomUUID()}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(error).toBe("")
  expect(code).toBe(0)
  return JSON.parse(output) as { output: string; code: number; restored: boolean }
}

for (const mode of ["modal-tail", "modal-paste", "modal-select"] as const) {
  test.skipIf(!supported)(
    `${mode} preserves parser ownership and cold-cache selection at the native dialog boundary`,
    async () => {
      const result = await run(
        `
      const { createCliRenderer } = await import(${coreModule});
      const early = getEarlyInput();
      const renderer = await createCliRenderer({ stdin: await early.takeover(), exitOnCtrlC: false, useMouse: false });
      renderer.keyInput.on("keypress", (key) => {
        if (key.name === "escape") early.closeModal();
        if (key.name === "return") { early.selectModel("test", "chosen"); early.closeModal(); }
      });
      early.openModal();
      process.stdout.write("MODEL_MODAL\\n");
      await Bun.sleep(350);
      process.stdout.write("DRAFT=" + JSON.stringify(early.claim()) + "\\n");
      renderer.destroy();
      await stopEarlyInput();
    `,
        mode,
      )
      if (mode === "modal-tail") expect(result.output).toContain('"text":"TAIL_MARK"')
      if (mode === "modal-paste") expect(result.output).toContain('"text":"PASTE_MARK"')
      if (mode === "modal-select")
        expect(result.output).toContain('"changes":[{"target":"select-model","providerID":"test","modelID":"chosen"}]')
      expect(result.code).toBe(0)
      expect(result.restored).toBe(true)
    },
    15000,
  )
}

test.skipIf(!supported)(
  "metadata mouse cycling works in the first ANSI frame while main imports are blocked",
  async () => {
    const result = await run(
      `
    const until = Date.now() + 1000;
    while (Date.now() < until) {}
    const early = getEarlyInput();
    await early.takeover();
    process.stdout.write("SELECTION=" + JSON.stringify(early.presentation.selection) + "\\nDRAFT=" + JSON.stringify(early.claim()) + "\\n");
    await stopEarlyInput();
  `,
      "controls",
      [],
      `
    const { startupPresentation } = await import(${JSON.stringify(import.meta.resolve("@opencode-ai/tui/startup/presentation"))});
    await Bun.write(process.env.XDG_STATE_HOME + "/opencode/startup-presentation.json", JSON.stringify({
      ...startupPresentation(),
      selection: { directory: process.cwd(), agent: "Build", agentID: "build", model: "Model A", modelID: "a", provider: "Provider", providerID: "test", variant: "default" },
      controls: { directory: process.cwd(), providerID: "test", agents: [], models: [
        { id: "a", name: "Model A", variants: ["high", "low"] },
        { id: "b", name: "Model B", variants: ["fast"], variant: "fast" }
      ] }
    }));
  `,
    )
    expect(result.output).toContain('"model":"Model B"')
    expect(result.output).toContain('"variant":"default"')
    expect(result.output).toContain(
      '"changes":[{"target":"variant","direction":1},{"target":"model","direction":1},{"target":"variant","direction":-1}]',
    )
    expect(result.output).toContain("\x1b[?1000h\x1b[?1006h")
    expect(result.output).toContain("\x1b[?1000l\x1b[?1006l")
    expect(result.code).toBe(0)
    expect(result.restored).toBe(true)
  },
  15000,
)

test.skipIf(!supported)(
  "slash popup filters and selects before main-thread imports finish",
  async () => {
    const result = await run(
      `
    const until = Date.now() + 800;
    while (Date.now() < until) {}
    process.stdout.write("MAIN_UNBLOCKED\\n");
    const early = getEarlyInput();
    await early.takeover();
    process.stdout.write("DRAFT=" + JSON.stringify(early.claim()) + "\\n");
    await stopEarlyInput();
  `,
      "slash",
    )
    expect(result.output.indexOf("/models")).toBeGreaterThan(-1)
    expect(result.output.indexOf("/models")).toBeLessThan(result.output.indexOf("MAIN_UNBLOCKED"))
    expect(result.output).toContain("Switch model")
    expect(result.output).toContain("\x1b[48;2;250;178;131m")
    expect(result.output).toContain('"command":{"name":"model.list","display":"/models","prefix":"/models "}')
    expect(result.output).toContain('"text":"/models "')
    expect(result.restored).toBe(true)
    expect(result.code).toBe(0)
  },
  15000,
)

test.skipIf(!supported)(
  "cached model, variant and agent render while the main loop is blocked, and remain read-only",
  async () => {
    const result = await run(
      `
      const until = Date.now() + 800;
      while (Date.now() < until) {}
      process.stdout.write("MAIN_UNBLOCKED\\n");
      const early = getEarlyInput();
      await early.takeover();
      process.stdout.write("SELECTION=" + JSON.stringify(early.presentation.selection) + "\\n");
      await stopEarlyInput();
    `,
      "cached",
      [],
      `
      const { startupPresentation } = await import(${JSON.stringify(import.meta.resolve("@opencode-ai/tui/startup/presentation"))});
      await Bun.write(process.env.XDG_STATE_HOME + "/opencode/startup-presentation.json", JSON.stringify({
        ...startupPresentation(),
        selection: { directory: process.cwd(), agent: "Plan", model: "Cached Model", provider: "Provider", variant: "high", agentColor: "#778899", variantColor: "#112233" }
      }));
    `,
    )
    const plain = result.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    expect(plain.indexOf("Plan · Cached Model Provider · high")).toBeGreaterThan(-1)
    expect(plain.indexOf("Plan · Cached Model Provider · high")).toBeLessThan(plain.indexOf("MAIN_UNBLOCKED"))
    expect(result.output).toContain("\x1b[38;2;119;136;153m\x1b[22mPlan")
    expect(result.output).toContain("\x1b[38;2;17;34;51m\x1b[1mhigh\x1b[22m")
    expect(result.output).toContain("cached selection")
    expect(result.output).toContain('"variant":"high"')
    expect(result.output).toContain("abZ界")
    expect(result.code).toBe(0)
    expect(result.restored).toBe(true)
  },
  15000,
)

test.skipIf(!supported)(
  "worker follows terminal resize while the importing main loop is blocked",
  async () => {
    const result = await run(
      `
      const until = Date.now() + 800;
      while (Date.now() < until) {}
      process.stdout.write("MAIN_UNBLOCKED\\n");
      await stopEarlyInput();
    `,
      "resize",
    )
    expect(result.output).toContain("\x1b[21;27H")
    expect(result.output.indexOf("\x1b[13;7H")).toBeGreaterThan(-1)
    expect(result.output.indexOf("\x1b[13;7H")).toBeLessThan(result.output.indexOf("MAIN_UNBLOCKED"))
    expect(result.output).toContain("abZ界")
    expect(result.code).toBe(0)
    expect(result.restored).toBe(true)
  },
  15000,
)

test.skipIf(!supported)(
  "typing stays live during blocked startup; fragmented paste crosses handoff exactly once",
  async () => {
    const result = await run(
      `
    const until = Date.now() + 800;
    while (Date.now() < until) {}
    process.stdout.write("MAIN_UNBLOCKED\\n");
    const early = getEarlyInput();
    const terminal = await early.takeover();
    terminal.on("data", (chunk) => {
      process.stdout.write("NATIVE=" + JSON.stringify(chunk.toString()) + "\\n");
      terminal.pause();
      if (process.stdin.readableFlowing !== false) throw new Error("suspension kept reading the real TTY");
      early.dispose();
      process.exit(0);
    });
    if (early.claim()) throw new Error("claimed an incomplete paste");
    process.stdout.write("WAITING\\n");
    early.subscribe(() => {
      const draft = early.claim();
      if (!draft) return;
      process.stdout.write("DRAFT=" + JSON.stringify(draft) + "\\nCLAIMED\\n");
    });
  `,
      "handoff",
    )
    expect(result.output.indexOf("abZ界")).toBeGreaterThan(-1)
    expect(result.output.indexOf("abZ界")).toBeLessThan(result.output.indexOf("MAIN_UNBLOCKED"))
    expect(result.output).toContain('DRAFT={"text":"abZone\\ntwo!界","cursor":11}')
    expect(result.output).toContain('NATIVE="next"')
    expect(result.code).toBe(0)
    expect(result.restored).toBe(true)
    expect(result.output).toContain("\x1b[?2004l")
  },
  15000,
)

test.skipIf(!supported)(
  "direct process.exit during blocked startup preserves the visible draft and restores terminal modes",
  async () => {
    const result = await run(
      `
      const until = Date.now() + 800;
      while (Date.now() < until) {}
      process.stderr.write("CONFIG_FAILED\\n");
      process.exit(17);
    `,
      "exit",
      [".", "--pure"],
    )
    expect(result.output.slice(result.output.indexOf("CONFIG_FAILED")).replaceAll("\r", "")).toContain(
      "Unsent startup draft (not submitted):\nabZ界",
    )
    expect(result.code).toBe(17)
    expect(result.restored).toBe(true)
    expect(result.output).toContain("\x1b[?2004l")
  },
  15000,
)

test.skipIf(!supported)(
  "awaited startup failure cleanup preserves the draft before the CLI reports an error",
  async () => {
    const result = await run(
      `
      await Bun.sleep(600);
      await stopEarlyInput();
      process.stderr.write("CONFIG_FAILED\\n");
      process.exit(1);
    `,
      "exit",
      ["../repo"],
    )
    expect(result.output).toContain("Unsent startup draft (not submitted):")
    expect(result.output.lastIndexOf("abZ界")).toBeLessThan(result.output.indexOf("CONFIG_FAILED"))
    expect(result.code).toBe(1)
    expect(result.restored).toBe(true)
    expect(result.output).toContain("\x1b[?2004l")
  },
  15000,
)

test.skipIf(!supported)(
  "Ctrl-C cancels startup and restores the terminal",
  async () => {
    const result = await run(`await new Promise(() => {})`, "cancel")
    expect(result.code).toBe(130)
    expect(result.restored).toBe(true)
    expect(result.output).toContain("\x1b[?2004l")
  },
  15000,
)

test.skipIf(!supported)(
  "claimed input releases SIGHUP to the mounted TUI shutdown handler",
  async () => {
    const result = await run(
      `
      await Bun.sleep(600);
      const early = getEarlyInput();
      await early.takeover();
      process.on("SIGHUP", () => {
        process.stdout.write("APP_SCOPED_SHUTDOWN\\n");
        early.dispose();
        process.exit(0);
      });
      if (!early.claim()) throw new Error("draft was not claimable");
      process.stdout.write("CLAIMED\\n");
      await new Promise(() => {});
    `,
      "hangup",
    )
    expect(result.output).toContain("APP_SCOPED_SHUTDOWN")
    expect(result.code).toBe(0)
    expect(result.restored).toBe(true)
  },
  15000,
)

test.skipIf(!supported)(
  "SIGTERM during startup restores the terminal",
  async () => {
    const result = await run(`await new Promise(() => {})`, "signal")
    expect(result.code).toBe(143)
    expect(result.restored).toBe(true)
    expect(result.output).toContain("\x1b[?2004l")
  },
  15000,
)

for (const phase of ["preclaim", "claimed"] as const) {
  for (const action of ["SIGTERM", "SIGINT", "SIGHUP", "ctrl-c"] as const) {
    test.skipIf(!supported)(
      `real renderer ${phase} ${action} restores the alternate screen and unwinds its scope`,
      async () => {
        const result = await run(
          `
          const early = getEarlyInput();
          const stdin = await early.takeover();
          await new Promise((resolve) => {
            const check = () => {
              if (early.read().text !== "abZ界") return;
              off();
              resolve();
            };
            const off = early.subscribe(check);
            check();
          });
          const { Effect, Deferred } = await import(${effectModule});
          const { createInputRenderer, destroyRenderer } = await import(${rendererModule});
          await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.sync(() => {
              early.dispose();
              process.stdout.write("EARLY_DISPOSED\\n");
            }));
            const shutdown = yield* Deferred.make();
            const renderer = yield* Effect.acquireRelease(
              Effect.promise(() => createInputRenderer({
                stdin, exitOnCtrlC: false, useKittyKeyboard: null, useMouse: false, openConsoleOnError: false,
                onDestroy() {
                  if (process.stdin.readableFlowing !== false) throw new Error("renderer shutdown left the TTY reader active");
                  process.stdout.write("RENDERER_DESTROYED\\n");
                  Deferred.doneUnsafe(shutdown, Effect.void);
                },
              }, early)),
              (renderer) => Effect.sync(() => {
                destroyRenderer(renderer);
                process.stdout.write("SCOPED_RENDERER_RELEASE\\n");
              }),
            );
            yield* Effect.addFinalizer(() => Effect.sync(() => process.stdout.write("SCOPE_FINALIZER\\n")));
            renderer.keyInput.on("keypress", (event) => {
              if (!event.ctrl || event.name !== "c") return;
              process.stdout.write("NATIVE_CTRL_C\\n");
              destroyRenderer(renderer);
            });
            if (${phase === "claimed"} && !early.claim()) throw new Error("draft was not claimable");
            process.stdout.write("RENDERER_READY\\n");
            yield* Deferred.await(shutdown);
          })));
          process.stdout.write("SCOPED_DONE\\n");
          `,
          `renderer-${phase}-${action}`,
        )
        expect(result.code).toBe(0)
        expect(result.restored).toBe(true)
        expect(result.output).toContain("\x1b[?1049h")
        expect(result.output).toContain("\x1b[?1049l")
        expect(result.output).toContain("RENDERER_DESTROYED")
        expect(result.output).toContain("SCOPED_RENDERER_RELEASE")
        expect(result.output).toContain("SCOPE_FINALIZER")
        expect(result.output).toContain("EARLY_DISPOSED")
        expect(result.output).toContain("SCOPED_DONE")
        expect(result.output.indexOf("\x1b[?1049l")).toBeLessThan(result.output.indexOf("EARLY_DISPOSED"))
        if (phase === "preclaim") {
          expect(result.output).toContain("Unsent startup draft (not submitted):")
          expect(result.output.lastIndexOf("abZ界")).toBeGreaterThan(result.output.indexOf("\x1b[?1049l"))
        }
        if (phase === "claimed" && action === "ctrl-c") expect(result.output).toContain("NATIVE_CTRL_C")
      },
      15000,
    )
  }
}

import { createEarlyEditor, type EarlyDraft, type EarlyState } from "./early-editor"
import { PassThrough } from "node:stream"
import { MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads"
import {
  startupPresentation,
  homePromptWidth,
  homeInputHeight,
  homeGeometry,
  startupSelectionSegments,
  type StartupPresentation,
} from "@opencode-ai/tui/startup/presentation"
import { logo } from "@opencode-ai/tui/logo"
import { startupDraft } from "@opencode-ai/tui/startup/draft"
import { readStartupPresentation } from "@opencode-ai/tui/startup/read-presentation"
import { builtinStartupSlashes, createStartupSlashes, type StartupSlashMenu } from "@opencode-ai/tui/startup/slashes"
import { clickStartupSelection, type StartupControlTarget } from "@opencode-ai/tui/startup/controls"

export type EarlyInput = {
  readonly active: boolean
  readonly modal: boolean
  readonly presentation: StartupPresentation
  readonly location: { directory: string; displayDirectory: string; version: string; auto: boolean } | undefined
  read(): EarlyDraft
  completion(height?: number): StartupSlashMenu
  selectCompletion(index: number): void
  highlightCompletion(index: number): void
  clickSelection(target: StartupControlTarget | "provider", direction?: 1 | -1): void
  openModal(): void
  closeModal(): void
  selectModel(providerID: string, modelID: string): void
  subscribe(listener: () => void): () => void
  takeover(): Promise<NodeJS.ReadStream>
  onCancel(shutdown: () => void): void
  claim(): EarlyDraft | undefined
  dispose(): void
}

// Explicit paths cannot collide with subcommands; no filesystem lookup is
// needed. Resume stays excluded: a permission/question or subagent session can
// have no editable PromptRef to claim the draft and release keyboard capture.
export function canStartEarlyInput(args: string[], stdin: boolean, stdout: boolean, platform = process.platform) {
  if (!stdin || !stdout || platform === "win32" || process.env.TERM === "dumb" || process.env.OPENCODE_ROUTE)
    return false
  const positional = args.filter(
    (arg) => !["--pure", "--auto", "--yolo", "--dangerously-skip-permissions"].includes(arg),
  )
  return positional.length === 0 || (positional.length === 1 && /^(?:\.{1,2}$|\.{1,2}\/|\/)/.test(positional[0]))
}

let current: (EarlyInput & { stop(): Promise<void> }) | undefined

export function getEarlyInput(): EarlyInput | undefined {
  return current
}

export function startEarlyInput() {
  if (current || !canStartEarlyInput(process.argv.slice(2), !!process.stdin.isTTY, !!process.stdout.isTTY)) return
  const raw = process.stdin.isRaw
  const listeners = new Set<() => void>()
  let slashes = createStartupSlashes(builtinStartupSlashes())
  let editor = createEarlyEditor(undefined, undefined, slashes.key)
  let active = true
  let modal = false
  let capturing = false
  let transferred = false
  let closed = false
  let shutdown: (() => void) | undefined
  let escape: ReturnType<typeof setTimeout> | undefined
  let resolve: ((state: EarlyState) => void) | undefined
  let taking: Promise<NodeJS.ReadStream> | undefined
  let recovery: EarlyState | undefined
  let presentation = startupPresentation()
  let location: EarlyInput["location"]
  const channel = new MessageChannel()
  channel.port1.on("message", (state: EarlyState) => {
    recovery = state
  })
  // OpenTUI must not also read a chunk used to finish the startup draft. A
  // single raw reader routes whole chunks to exactly one editor, even if claim
  // happens inside a data callback (notably at the end of a bracketed paste).
  const terminal = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: true,
    setRawMode(mode: boolean) {
      process.stdin.setRawMode(mode)
      this.isRaw = mode
      return this
    },
  })
  // Once OpenTUI owns input, suspension (for $EDITOR or Ctrl-Z) must also
  // release the actual TTY reader, not just pause the forwarding stream.
  terminal.on("pause", () => {
    process.stdin.pause()
  })
  terminal.on("resume", () => {
    if (!closed) process.stdin.resume()
  })
  const worker = new Worker(
    "data:text/javascript," +
      encodeURIComponent(
        `(${earlyWorker.toString()})(${createEarlyEditor.toString()},${startupPresentation.toString()},${homePromptWidth.toString()},${homeInputHeight.toString()},${homeGeometry.toString()},${startupDraft.toString()},${readStartupPresentation.toString()},${startupSelectionSegments.toString()},${createStartupSlashes.toString()},${builtinStartupSlashes.toString()},${clickStartupSelection.toString()},${JSON.stringify(logo)},${JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD, args: process.argv.slice(2), version: typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local", disableMouse: ["1", "true"].includes(process.env.OPENCODE_DISABLE_MOUSE ?? "") })})`,
      ),
  )
  worker.postMessage(channel.port2, [channel.port2])
  const notify = () => listeners.forEach((listener) => listener())
  const cleanup = () => {
    if (closed) return
    closed = true
    shutdown = undefined
    worker.terminate()
    // process.exit() does not await finally blocks or queued JS callbacks. Drain
    // the dedicated snapshot port synchronously, including while main was busy
    // evaluating modules. The worker publishes before displaying each edit.
    for (let message = receiveMessageOnPort(channel.port1); message; message = receiveMessageOnPort(channel.port1)) {
      recovery = message.message as EarlyState
    }
    channel.port1.close()
    process.stdin.off("data", capture)
    if (escape) clearTimeout(escape)
    process.off("exit", cleanup)
    process.off("SIGTERM", terminate)
    process.off("SIGHUP", hangup)
    process.off("SIGINT", interrupt)
    terminal.destroy()
    process.stdin.setRawMode(raw)
    process.stdin.pause()
    process.stdout.write(
      (capturing ? "" : "\x1b[<u") +
        "\x1b[?1000l\x1b[?1006l\x1b[?2026l\x1b[?1049l\x1b[?2004l\x1b[?25h\x1b[0 q\x1b]112\x07\x1b[0m" +
        (transferred ? "" : "\r\n"),
    )
    const draft = capturing ? editor.state.text : recovery?.text
    if (!transferred && draft) process.stdout.write("Unsent startup draft (not submitted):\r\n" + draft + "\r\n")
    active = false
  }
  const cancel = (code: number) => {
    // Once renderer setup begins, its owner must unwind the renderer and its
    // Effect scope before disposing this reader or exiting the process.
    if (shutdown) return shutdown()
    cleanup()
    process.exit(code)
  }
  const terminate = () => cancel(143)
  const hangup = () => cancel(129)
  const interrupt = () => cancel(130)
  const capture = (chunk: Buffer) => {
    if (!active) {
      terminal.write(chunk)
      return
    }
    if (modal) {
      // A native key can close the modal synchronously. Stop forwarding at that
      // exact event boundary so following text/paste belongs to the early editor.
      let index = 0
      while (index < chunk.length && modal) terminal.write(chunk.subarray(index, ++index))
      if (index < chunk.length) capture(chunk.subarray(index))
      return
    }
    if (editor.feed(chunk) === "cancel") {
      interrupt()
      return
    }
    if (escape) clearTimeout(escape)
    escape = setTimeout(() => {
      if (!active || closed) return
      editor.escape()
      notify()
    }, 40)
    notify()
  }
  worker.onmessage = (
    event: MessageEvent<
      EarlyState & { presentation: StartupPresentation; location: NonNullable<EarlyInput["location"]> }
    >,
  ) => {
    if (closed) return
    slashes = createStartupSlashes(event.data.presentation.slashes?.items ?? builtinStartupSlashes())
    editor = createEarlyEditor(
      event.data,
      (sequence) => terminal.write(sequence),
      slashes.key,
      event.data.presentation.inputBindings,
    )
    presentation = event.data.presentation
    location = event.data.location
    // The worker has paused and drained its reader before acknowledging. Install
    // the next reader in this same callback; kernel-buffered input stays raw.
    capturing = true
    process.stdin.on("data", capture)
    process.stdin.resume()
    escape = setTimeout(() => {
      if (!active || closed) return
      editor.escape()
      notify()
    }, 40)
    resolve?.(event.data)
  }
  worker.onerror = (event) => {
    if (closed) return
    // Fail explicitly rather than discarding a potentially edited draft.
    console.error("Early input failed:", event.message)
    process.exitCode = 1
    cancel(1)
  }
  process.once("exit", cleanup)
  process.once("SIGTERM", terminate)
  process.once("SIGHUP", hangup)
  process.once("SIGINT", interrupt)
  current = {
    get active() {
      return active
    },
    get modal() {
      return modal
    },
    get presentation() {
      return presentation
    },
    get location() {
      return location
    },
    read: () => ({
      text: editor.state.text,
      cursor: editor.state.cursor,
      ...(editor.state.slash ? { slash: editor.state.slash } : {}),
      ...(editor.state.command ? { command: editor.state.command } : {}),
      ...(editor.state.changes ? { changes: editor.state.changes } : {}),
      ...(editor.state.submit ? { submit: true } : {}),
    }),
    completion: (height) => slashes.view(editor.state, height),
    selectCompletion(index) {
      if (!active || !capturing) return
      slashes.select(editor.state, index)
      notify()
    },
    highlightCompletion(index) {
      if (!active || !capturing) return
      const option = slashes.view(editor.state)?.options[index]
      if (!option || !editor.state.slash) return
      editor.state.slash.selected = option.display.trimEnd()
      notify()
    },
    clickSelection(target, direction) {
      if (!active || !capturing || modal) return
      clickStartupSelection(presentation, editor.state, target, direction)
      notify()
    },
    openModal() {
      if (!active || modal || !capturing || !editor.settled) return
      const prefix = editor.state.command?.prefix ?? ""
      if (prefix && editor.state.text.startsWith(prefix)) {
        editor.state.text = editor.state.text.slice(prefix.length)
        editor.state.cursor = Math.max(0, editor.state.cursor - prefix.length)
      }
      delete editor.state.command
      delete editor.state.slash
      modal = true
      if (escape) clearTimeout(escape)
      notify()
    },
    closeModal() {
      if (!active || closed || !modal) return
      modal = false
      notify()
    },
    selectModel(providerID, modelID) {
      if (!active || !capturing) return
      editor.state.changes = [...(editor.state.changes ?? []), { target: "select-model", providerID, modelID }]
      const model =
        presentation.controls?.providerID === providerID
          ? presentation.controls.models.find((model) => model.id === modelID)
          : undefined
      if (model && presentation.selection)
        presentation.selection = {
          ...presentation.selection,
          providerID,
          modelID,
          model: model.name,
          variant: model.variant ?? "default",
        }
      notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    takeover() {
      return (taking ??= new Promise<EarlyState>((done) => {
        resolve = done
        worker.postMessage("takeover")
      }).then(() => {
        worker.terminate()
        return terminal as unknown as NodeJS.ReadStream
      }))
    },
    onCancel(handler) {
      shutdown = handler
    },
    claim() {
      if (!active || modal || !capturing || !editor.settled) return
      slashes.view(editor.state)
      const draft = current!.read()
      transferred = true
      active = false
      if (escape) clearTimeout(escape)
      escape = undefined
      // The mounted TUI now owns signals and must run its scoped shutdown.
      process.off("SIGHUP", hangup)
      process.off("SIGINT", interrupt)
      process.off("SIGTERM", terminate)
      notify()
      return draft
    },
    dispose: cleanup,
    async stop() {
      if (closed) return
      if (active) await current?.takeover()
      cleanup()
    },
  }
}

export async function stopEarlyInput() {
  await current?.stop()
}

// Runs in a separate JS event loop so synchronous module evaluation cannot
// freeze editing. Serialized instead of importing a worker bundle: this avoids
// dragging the application's shared bundle into the first-input path.
function earlyWorker(
  create: typeof createEarlyEditor,
  defaults: typeof startupPresentation,
  promptWidth: typeof homePromptWidth,
  inputHeight: typeof homeInputHeight,
  geometry: typeof homeGeometry,
  project: typeof startupDraft,
  read: typeof readStartupPresentation,
  segments: typeof startupSelectionSegments,
  autocomplete: typeof createStartupSlashes,
  builtins: typeof builtinStartupSlashes,
  click: typeof clickStartupSelection,
  logo: { left: string[]; right: string[] },
  launch: { cwd: string; pwd?: string; args: string[]; version: string; disableMouse: boolean },
) {
  const stdin = process.stdin
  const stdout = process.stdout
  const raw = stdin.isRaw
  let segmenter: Intl.Segmenter | undefined
  let escape: ReturnType<typeof setTimeout> | undefined
  let recovery: MessagePort | undefined
  let resizing: ReturnType<typeof setInterval> | undefined
  const path = process.getBuiltinModule("node:path")
  const target = launch.args.find((arg) => !arg.startsWith("--"))
  const directory = target ? path.resolve(launch.pwd || launch.cwd, target) : launch.cwd
  const home = process.getBuiltinModule("node:os").homedir()
  const displayDirectory = (
    directory === home ? "~" : directory.startsWith(home + "/") ? "~" + directory.slice(home.length) : directory
  ).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, "")
  const auto = launch.args.some((arg) => ["--auto", "--yolo", "--dangerously-skip-permissions"].includes(arg))
  const location = { directory, displayDirectory, version: launch.version, auto }
  const theme = read(defaults, process.env, directory)
  const slashes = autocomplete(theme.slashes?.items ?? builtins())
  const editor = create(undefined, (sequence) => pointer(sequence), slashes.key, theme.inputBindings)
  let hits: { left: number; right: number; row: number; target?: StartupControlTarget | "provider"; index?: number }[] =
    []
  const pointer = (sequence: string) => {
    const mouse = sequence.match(/^\x1b\[<(\d+);(\d+);(\d+)m$/)
    if (!mouse || launch.disableMouse || !theme.mouse) return
    const button = Number(mouse[1])
    if (button & 32 || button & 64 || ![0, 2].includes(button & 3)) return
    const column = Number(mouse[2]) - 1
    const row = Number(mouse[3]) - 1
    const hit = hits.find((hit) => hit.row === row && hit.left <= column && column < hit.right)
    if (hit?.target) click(theme, editor.state, hit.target, (button & 3) === 2 ? -1 : 1)
    if (hit?.index !== undefined) slashes.select(editor.state, hit.index)
  }
  const hint = theme.selection
    ? "Starting · cached selection · Enter submits · Shift+Enter adds a line"
    : "Enter submits · Shift+Enter adds a line · Ctrl-C exits"
  const clip = (text: string, width: number) => {
    if (/^[\x20-\x7e]*$/.test(text)) return text.slice(0, Math.max(0, width))
    if (Bun.stringWidth(text) <= width) return text
    let cells = 0
    let end = 0
    for (const part of (segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" })).segment(text)) {
      cells += Bun.stringWidth(part.segment)
      if (cells > width) break
      end = part.index + part.segment.length
    }
    return text.slice(0, end)
  }
  const color = (hex: string, background = false) =>
    hex === "transparent"
      ? `\x1b[${background ? 49 : 39}m`
      : `\x1b[${background ? 48 : 38};2;${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";")}m`
  const shadow = (foreground: string) =>
    "#" +
    [1, 3, 5]
      .map((i) => {
        const background = theme.background === "transparent" ? 0 : parseInt(theme.background.slice(i, i + 2), 16)
        return Math.round(background + (parseInt(foreground.slice(i, i + 2), 16) - background) * 0.25)
          .toString(16)
          .padStart(2, "0")
      })
      .join("")
  const logoLines = logo.left.map((line, row) =>
    [line, logo.right[row]].flatMap((part, index) => {
      const foreground = index ? "#d49a66" : theme.text
      const shade = shadow(foreground)
      const bold = index ? "\x1b[1m" : "\x1b[22m"
      const cells = Array.from(part).map((char) => {
        if (char === "_" || char === "^")
          return { style: bold + color(foreground) + color(shade, true), text: char === "_" ? " " : "▀" }
        return {
          style: bold + color(char === "~" || char === "," ? shade : foreground) + color(theme.background, true),
          text: char === "~" ? "▀" : char === "," ? "▄" : char,
        }
      })
      return index ? [{ style: "\x1b[22m" + color(theme.background, true), text: " " }, ...cells] : cells
    }),
  )
  const draw = () => {
    hits = []
    const columns = stdout.columns || 80
    const screenHeight = stdout.rows || 24
    const boxWidth = promptWidth(columns, theme.maxWidth)
    const width = Math.max(1, boxWidth - 5)
    const maxHeight = inputHeight(screenHeight, theme.maxHeight)
    const { rows, cursor, height, top } = editor.state.text
      ? project(
          editor.state.text,
          editor.state.cursor,
          width,
          (segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" })),
          maxHeight,
        )
      : { rows: [""], cursor: { row: 0, column: 0 }, height: 1, top: 0 }
    const visible = rows.slice(top, top + height)
    const layout = geometry(columns, screenHeight, boxWidth, height, theme.bottomHeight, theme.footerHeight)
    const at = (x: number, y: number) =>
      `\x1b[${Math.max(1, Math.min(screenHeight, y + 1))};${Math.max(1, Math.min(columns, x + 1))}H`
    const menu = slashes.view(editor.state, layout.promptTop)
    const output = ["\x1b[?2026h\x1b[?25l", color(theme.background, true), "\x1b[2J"]
    logoLines.forEach((line, row) => {
      if (layout.logoTop + row >= screenHeight) return
      const clipped = line.slice(0, Math.max(0, columns - 4))
      output.push(
        at(Math.max(2, Math.round((columns - 49) / 2)), layout.logoTop + row),
        clipped.map((cell, index) => (clipped[index - 1]?.style === cell.style ? "" : cell.style) + cell.text).join(""),
        "\x1b[22m",
      )
    })
    for (let row = 0; row < height + 3; row++) {
      if (layout.promptTop + row >= screenHeight) break
      output.push(
        at(layout.left, layout.promptTop + row),
        color(theme.background, true),
        color(theme.border),
        "┃",
        color(theme.backgroundElement, true),
        " ".repeat(Math.max(0, boxWidth - 1)),
      )
    }
    visible.forEach((line, row) => {
      if (layout.textTop + row >= screenHeight) return
      output.push(
        at(layout.left + 3, layout.textTop + row),
        color(theme.text),
        color(theme.backgroundElement, true),
        line,
      )
    })
    if (layout.textTop + height + 1 < screenHeight) {
      output.push(at(layout.left + 3, layout.textTop + height + 1))
      let remaining = width
      for (const segment of segments(theme, auto)) {
        if (remaining <= 0) break
        const text = clip(segment.text, remaining)
        if (segment.target)
          hits.push({
            left: layout.left + 3 + width - remaining,
            right: layout.left + 3 + width - remaining + Bun.stringWidth(text),
            row: layout.textTop + height + 1,
            target: segment.target,
          })
        output.push(color(segment.color), segment.bold ? "\x1b[1m" : "\x1b[22m", text)
        remaining -= Bun.stringWidth(text)
      }
      output.push("\x1b[22m")
    }
    if (layout.promptTop + height + 3 < screenHeight)
      output.push(
        at(layout.left, layout.promptTop + height + 3),
        color(theme.background, true),
        color(theme.border),
        theme.backgroundElement === "transparent" ? " " : "╹",
        color(theme.backgroundElement),
        (theme.backgroundElement === "transparent" ? " " : "▀").repeat(Math.max(0, boxWidth - 1)),
      )
    if (layout.promptTop + height + 4 < screenHeight)
      output.push(
        at(layout.left, layout.promptTop + height + 4),
        color(theme.textMuted),
        clip(
          editor.state.command
            ? `Opening ${editor.state.command.display} when ready · Ctrl-C exits`
            : menu
              ? "↑↓ select · Tab/Enter choose · Esc dismiss · starting"
              : editor.state.submit
                ? "Submitting when ready · Shift+Enter adds a line · Ctrl-C exits"
                : editor.state.changes?.length
                  ? "Selection changes apply when ready · Enter submits"
                  : hint,
          boxWidth,
        ),
      )
    if (theme.footerHeight >= 2 && screenHeight > theme.footerHeight) {
      output.push(at(2, screenHeight - theme.footerHeight + 1), color(theme.background, true), color(theme.textMuted))
      const version = clip(launch.version, Math.max(0, columns - 4))
      const available = Math.max(0, columns - Bun.stringWidth(version) - 6)
      output.push(
        clip(displayDirectory, available),
        at(Math.max(2, columns - Bun.stringWidth(version) - 2), screenHeight - theme.footerHeight + 1),
        version,
      )
    }
    if (menu) {
      for (let row = 0; row < menu.height; row++) {
        const index = menu.top + row
        const option = menu.options[index]
        if (option)
          hits.push({
            left: layout.left + 1,
            right: layout.left + boxWidth - 1,
            row: layout.promptTop - menu.height + row,
            index,
          })
        const selected = index === menu.selected && !!option
        const foreground = selected ? theme.selectedText : theme.text
        const background = selected ? theme.primary : theme.backgroundMenu
        output.push(
          at(layout.left, layout.promptTop - menu.height + row),
          color(theme.background, true),
          color(theme.menuBorder),
          "┃",
          color(background, true),
          " ".repeat(Math.max(0, boxWidth - 2)),
          color(theme.background, true),
          color(theme.menuBorder),
          "┃",
        )
        output.push(
          at(layout.left + 2, layout.promptTop - menu.height + row),
          color(background, true),
          color(option ? foreground : theme.textMuted),
          clip(option?.display ?? "No matching items", Math.max(0, boxWidth - 4)),
        )
        if (option?.description && Bun.stringWidth(option.display) < boxWidth - 4) {
          output.push(
            color(selected ? theme.selectedText : theme.textMuted),
            clip(" " + option.description.trimStart(), Math.max(0, boxWidth - 4 - Bun.stringWidth(option.display))),
          )
        }
      }
    }
    output.push(
      at(layout.left + 3 + Math.min(cursor.column, width), layout.textTop + cursor.row - top),
      color(theme.text),
      color(theme.backgroundElement, true),
      "\x1b[?25h\x1b[?2026l",
    )
    stdout.write(output.join(""))
  }
  const capture = (chunk: Buffer) => {
    const result = editor.feed(chunk)
    slashes.view(editor.state)
    recovery?.postMessage(editor.state)
    if (result === "cancel") {
      stdin.setRawMode(raw)
      stdout.write("\x1b[?2004l\x1b[?25h\x1b[0m\r\n")
      process.kill(process.pid, "SIGINT")
      return
    }
    if (escape) clearTimeout(escape)
    escape = setTimeout(() => {
      editor.escape()
      slashes.view(editor.state)
      recovery?.postMessage(editor.state)
      draw()
    }, 40)
    draw()
  }
  // Bun delivers process signals on the main loop, which may still be busy
  // importing modules. Refresh the worker's cached TTY dimensions independently;
  // this is the same ioctl-backed refresh used by node:tty, not a new native layer.
  const resize = () => (stdout as typeof stdout & { _refreshSize(): void })._refreshSize()
  self.onmessage = (event: MessageEvent<MessagePort | "takeover">) => {
    if (event.data !== "takeover") {
      recovery = event.data
      recovery.postMessage(editor.state)
      stdin.setRawMode(true)
      stdin.on("data", capture)
      stdin.resume()
      // Disambiguate modified Enter immediately, matching OpenTUI's keyboard
      // protocol. Pop our entry before the renderer installs its own settings.
      stdout.write("\x1b[?1049h\x1b[?2004h\x1b[>1u")
      if (theme.mouse && !launch.disableMouse) stdout.write("\x1b[?1000h\x1b[?1006h")
      if (theme.cursorStyle !== "default")
        stdout.write(
          `\x1b[${{ block: 1, underline: 3, line: 5 }[theme.cursorStyle] + (theme.cursorBlinking ? 0 : 1)} q`,
        )
      stdout.write(`\x1b]12;${theme.text}\x07`)
      draw()
      stdout.on("resize", draw)
      process.on("SIGWINCH", resize)
      resizing = setInterval(resize, 50)
      return
    }
    stdin.pause()
    stdout.write("\x1b[<u\x1b[?1000l\x1b[?1006l")
    stdin.off("data", capture)
    // Readable streams may have prefetched beyond the last data callback.
    for (let chunk = stdin.read(); chunk !== null; chunk = stdin.read()) capture(chunk)
    if (escape) clearTimeout(escape)
    if (resizing) clearInterval(resizing)
    stdout.off("resize", draw)
    process.off("SIGWINCH", resize)
    postMessage({ ...editor.state, presentation: theme, location })
  }
}

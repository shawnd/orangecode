import type { StartupSlashDraft } from "@opencode-ai/tui/startup/slashes"
import type { StartupInputBindings } from "@opencode-ai/tui/startup/presentation"

export type EarlyDraft = Omit<StartupSlashDraft, "paste">

export type EarlyState = EarlyDraft & {
  pending: string
  bytes: number[]
  paste: boolean
}

// This function is also serialized into the input worker. Keep it self-contained:
// no module bindings, terminal libraries, or application imports.
export function createEarlyEditor(
  initial?: EarlyState,
  response?: (sequence: string) => void,
  intercept?: (key: string, state: EarlyState, binding: string) => boolean,
  bindings?: StartupInputBindings,
) {
  const state: EarlyState = initial ?? { text: "", cursor: 0, pending: "", bytes: [], paste: false }
  let segmenter: Intl.Segmenter | undefined
  const segments = (text: string) =>
    (segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" })).segment(text)
  const boundaries = () => [...segments(state.text)].map((item) => item.index).concat(state.text.length)
  const insert = (text: string) => {
    state.text = state.text.slice(0, state.cursor) + text + state.text.slice(state.cursor)
    state.cursor += text.length
  }
  const move = (direction: number) => {
    const points = boundaries()
    state.cursor =
      direction < 0
        ? (points.findLast((point) => point < state.cursor) ?? 0)
        : (points.find((point) => point > state.cursor) ?? state.text.length)
  }
  const erase = (backward: boolean) => {
    const before = state.cursor
    move(backward ? -1 : 1)
    const start = Math.min(before, state.cursor)
    state.text = state.text.slice(0, start) + state.text.slice(Math.max(before, state.cursor))
    state.cursor = start
  }
  const vertical = (direction: number) => {
    const start = state.text.slice(0, state.cursor).lastIndexOf("\n") + 1
    if (direction < 0 && start === 0) return
    const column = [...segments(state.text.slice(start, state.cursor))].length
    const next =
      direction < 0 ? state.text.slice(0, start - 1).lastIndexOf("\n") + 1 : state.text.indexOf("\n", state.cursor) + 1
    if (direction > 0 && next === 0) return
    const end = state.text.indexOf("\n", next)
    const line = state.text.slice(next, end < 0 ? undefined : end)
    state.cursor =
      next +
      [...segments(line)]
        .slice(0, column)
        .map((item) => item.segment)
        .join("").length
  }
  const inputBindings = bindings ?? {
    submit: ["return"],
    newline: ["shift+return", "ctrl+return", "alt+return", "ctrl+j"],
  }
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/(?:^|\+)enter$/, (value) => value.replace("enter", "return"))
      .split("+")
      .sort()
      .join("+")
  const key = (value: string, binding?: string) => {
    if (value === "\x03" || (value === "\x04" && !state.text)) return "cancel"
    if (value === "\x1b") delete state.submit
    const stroke = normalize(
      binding ??
        (value === "\r"
          ? "return"
          : value === "\t"
            ? "tab"
            : value === "\x1b[Z"
              ? "shift+tab"
              : value === "\x1b\r"
                ? "alt+return"
                : value.length === 1 && value.charCodeAt(0) > 0 && value.charCodeAt(0) < 27
                  ? `ctrl+${String.fromCharCode(value.charCodeAt(0) + 96)}`
                  : value),
    )
    if (inputBindings.newline.some((binding) => normalize(binding) === stroke)) return insert("\n")
    if (((value !== "\r" && value !== "\n") || stroke === "return") && intercept?.(value, state, stroke)) return
    if (inputBindings.submit.some((binding) => normalize(binding) === stroke)) {
      if (state.text.trim() && !state.command) state.submit = true
      return
    }
    if (value === "\x7f" || value === "\b") return erase(true)
    if (value === "\x1b[3~" || value === "\x04") return erase(false)
    if (value === "\x1b[D" || value === "\x1bOD" || value === "\x02") return move(-1)
    if (value === "\x1b[C" || value === "\x1bOC" || value === "\x06") return move(1)
    if (value === "\x1b[A" || value === "\x1bOA") return vertical(-1)
    if (value === "\x1b[B" || value === "\x1bOB") return vertical(1)
    if (["\x1b[H", "\x1bOH", "\x1b[1~", "\x01"].includes(value)) {
      state.cursor = state.text.slice(0, state.cursor).lastIndexOf("\n") + 1
      return
    }
    if (["\x1b[F", "\x1bOF", "\x1b[4~", "\x05"].includes(value)) {
      const end = state.text.indexOf("\n", state.cursor)
      state.cursor = end < 0 ? state.text.length : end
      return
    }
    if (value === "\x15") {
      state.text = state.text.slice(state.cursor)
      state.cursor = 0
      return
    }
    if (value === "\x0b") {
      state.text = state.text.slice(0, state.cursor)
      return
    }
    if (value === "\x17") {
      const before = state.text.slice(0, state.cursor).replace(/\s*\S+\s*$/, "")
      state.text = before + state.text.slice(state.cursor)
      state.cursor = before.length
      return
    }
    if (value === "\r" || value === "\n") return
    if (value === "\t") return insert("  ")
    if (value >= " " && !value.startsWith("\x1b")) insert(value)
  }
  return {
    state,
    get settled() {
      return !state.pending && !state.bytes.length && !state.paste
    },
    escape() {
      if (state.pending === "\x1b") {
        state.pending = ""
        delete state.submit
        intercept?.("\x1b", state, "escape")
      }
    },
    feed(chunk: Uint8Array) {
      const bytes = new Uint8Array([...state.bytes, ...chunk])
      let end = bytes.length
      // Keep incomplete UTF-8 bytes across both read boundaries and worker handoff.
      for (let index = bytes.length - 1; index >= Math.max(0, bytes.length - 4); index--) {
        const byte = bytes[index]
        if ((byte & 0xc0) === 0x80) continue
        const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
        if (index + length > bytes.length) end = index
        break
      }
      state.bytes = [...bytes.slice(end)]
      state.pending += new TextDecoder().decode(bytes.slice(0, end))
      while (state.pending) {
        if (state.paste) {
          const end = state.pending.indexOf("\x1b[201~")
          if (end < 0) return
          // Terminal control bytes in pasted text are data, never commands.
          insert(
            state.pending
              .slice(0, end)
              .replace(/\r\n?/g, "\n")
              .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""),
          )
          state.pending = state.pending.slice(end + 6)
          state.paste = false
          continue
        }
        if (state.pending.startsWith("\x1b\x1b")) {
          state.pending = state.pending.slice(1)
          continue
        }
        const sequence = state.pending.startsWith("\x1b")
          ? state.pending.match(/^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|[\]P_^][\s\S]*?(?:\x07|\x1b\\)|[^\[O\]P_^])/)?.[0]
          : String.fromCodePoint(state.pending.codePointAt(0) ?? 0)
        if (!sequence) return state.pending.includes("\x03") ? "cancel" : undefined
        state.pending = state.pending.slice(sequence.length)
        if (sequence === "\x1b[200~") {
          state.paste = true
          continue
        }
        if (
          /^\x1b(?:[\]P_^]|\[[0-?]*[ -/]*[cntR]|\[\?[\d;]+u)/.test(sequence) ||
          /^\x1b\[\?\d+(?:;\d+)*\$y$/.test(sequence) ||
          /^\x1b\[<\d+;\d+;\d+[mM]$/.test(sequence)
        ) {
          response?.(sequence)
          continue
        }
        // Match both keyboard encodings accepted by OpenTUI.
        const kitty = sequence.match(/^\x1b\[(\d+)(?::(\d*))?(?::\d*)?(?:;(\d+)(?::(\d+))?)?u$/)
        const modified = sequence.match(/^\x1b\[27;(\d+);(\d+)~$/)
        if (kitty || modified) {
          if (kitty?.[4] === "3") continue
          const modifiers = Number(kitty?.[3] ?? modified?.[1] ?? 1) - 1
          const code = Number(modifiers & 1 && kitty?.[2] ? kitty[2] : (kitty?.[1] ?? modified?.[2]))
          const ctrl = (modifiers & 4) !== 0
          const special: Record<number, string> = {
            57349: "\x1b[3~",
            57350: "\x1b[D",
            57351: "\x1b[C",
            57352: "\x1b[A",
            57353: "\x1b[B",
            57356: "\x1b[H",
            57357: "\x1b[F",
          }
          if (code > 0x10ffff || (code >= 57344 && code <= 63743 && !special[code])) continue
          const value =
            special[code] ??
            (ctrl && code >= 97 && code <= 122 ? String.fromCharCode(code - 96) : String.fromCodePoint(code))
          const name = code === 13 ? "return" : code === 9 ? "tab" : code === 27 ? "escape" : String.fromCodePoint(code)
          const binding = [
            ctrl ? "ctrl" : "",
            modifiers & 2 ? "alt" : "",
            modifiers & 1 ? "shift" : "",
            modifiers & 56 ? "meta" : "",
            name,
          ]
            .filter(Boolean)
            .join("+")
          if (key(value, binding) === "cancel") return "cancel"
          continue
        }
        if (key(sequence) === "cancel") return "cancel"
      }
      if (!state.text.trim()) delete state.submit
    },
  }
}

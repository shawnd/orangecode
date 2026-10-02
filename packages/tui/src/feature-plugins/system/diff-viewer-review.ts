import {
  CodeRenderable,
  LineNumberRenderable,
  type DiffRenderable,
  type LineColorConfig,
  type LineSign,
  type RGBA,
} from "@opentui/core"
import type { PromptInfo } from "../../prompt/history"

export type DiffAnnotation = {
  id: string
  file: string
  source: string
  hunk: string
  side: "old" | "new"
  start: number
  end: number
  preview: string
  comment: string
}

export function diffHunks(patch: string) {
  const lines = patch.split("\n")
  const starts = lines.flatMap((line, index) => (/^@@ -\d/.test(line) ? [index] : []))
  const header = lines.slice(0, starts[0]).join("\n")
  return starts.map((start, index) => ({
    header: lines[start],
    patch: [header, ...lines.slice(start, starts[index + 1] ?? lines.length)].join("\n"),
  }))
}

// Resolve through OpenTUI's public gutter and wrapped-line maps. Screen rows are
// not patch rows, especially when split panes align lines of different lengths.
export function diffLineAt(node: DiffRenderable, x: number, y: number, gutterOnly = true) {
  const pane = node
    .getChildren()
    .find((child) => child instanceof LineNumberRenderable && x >= child.x && x < child.x + child.width)
  if (!(pane instanceof LineNumberRenderable)) return
  const code = pane.getChildren().find((child) => child instanceof CodeRenderable)
  if (!(code instanceof CodeRenderable) || (gutterOnly && x >= code.x)) return
  const row = code.lineInfo.lineSources[y - code.y + code.scrollY]
  if (row === undefined || pane.getHideLineNumbers().has(row)) return
  const line = pane.getLineNumbers().get(row)
  if (line === undefined) return
  const side =
    node.view === "split"
      ? node.getChildren().indexOf(pane) === 0
        ? "old"
        : "new"
      : pane.getLineSigns().get(row)?.after?.includes("-")
        ? "old"
        : "new"
  return { side, line } as const
}

export function diffLines(node: DiffRenderable, preferred: "old" | "new" = "new") {
  const lines = new Map<number, { side: "old" | "new"; line: number; y: number; changed: boolean }>()
  node.getChildren().forEach((pane, index) => {
    if (!(pane instanceof LineNumberRenderable)) return
    const code = pane.getChildren().find((child) => child instanceof CodeRenderable)
    if (!(code instanceof CodeRenderable)) return
    const seen = new Set<number>()
    code.lineInfo.lineSources.forEach((row, visual) => {
      if (seen.has(row)) return
      seen.add(row)
      if (pane.getHideLineNumbers().has(row)) return
      const line = pane.getLineNumbers().get(row)
      if (line === undefined) return
      const sign = pane.getLineSigns().get(row)?.after ?? ""
      const side = node.view === "split" ? (index === 0 ? "old" : "new") : sign.includes("-") ? "old" : "new"
      const y = code.y + visual - code.scrollY
      // Split panes share screen rows. Keep the active side when it has a real
      // source line, and use the other side for insertions/deletions only.
      if (!lines.has(y) || side === preferred)
        lines.set(y, { side, line, y, changed: sign.includes("+") || sign.includes("-") })
    })
  })
  return [...lines.values()].sort((left, right) => left.y - right.y)
}

const reservedGutters = new WeakMap<LineNumberRenderable, Map<number, number>>()

export function highlightDiffSelection(
  node: DiffRenderable,
  selection: { side: "old" | "new"; anchor: number; line: number } | undefined,
  colors: { range: RGBA; current: RGBA; accent: RGBA },
) {
  const original = new Map<LineNumberRenderable, Map<number, { color: LineColorConfig; sign?: LineSign }>>()
  const applied = new Map<LineNumberRenderable, Map<number, number>>()
  // Diff rebuilds its gutter maps after wrapping, syntax highlighting, and style
  // changes. Keep a marker cell in every pane, even without a selection: changing
  // the maximum sign width changes code wrapping on the next layout pass.
  const apply = () => {
    node.getChildren().forEach((pane, index) => {
      if (!(pane instanceof LineNumberRenderable)) return
      const numbers = pane.getLineNumbers()
      // OpenTUI replaces the source-number map whenever it rebuilds the gutter
      // (including style and wrap changes), but mutates signs/colors in place.
      // Use that revision to avoid scanning every row on every render pass.
      if (applied.get(pane) === numbers) return
      const signs = pane.getLineSigns()
      if (reservedGutters.get(pane) !== numbers) {
        const missing = [...numbers.keys()].filter((row) => !signs.get(row)?.before)
        if (missing.length)
          pane.setLineSigns(
            new Map([...signs, ...missing.map((row) => [row, { ...signs.get(row), before: " " }] as const)]),
          )
        reservedGutters.set(pane, numbers)
      }
      applied.set(pane, numbers)
      if (!selection) return
      const saved = original.get(pane) ?? new Map<number, { color: LineColorConfig; sign?: LineSign }>()
      original.set(pane, saved)
      const updates = new Map<number, LineSign>()
      numbers.forEach((line, row) => {
        const sign = pane.getLineSigns().get(row)
        const side = node.view === "split" ? (index === 0 ? "old" : "new") : sign?.after?.includes("-") ? "old" : "new"
        if (
          pane.getHideLineNumbers().has(row) ||
          side !== selection.side ||
          line < Math.min(selection.anchor, selection.line) ||
          line > Math.max(selection.anchor, selection.line)
        )
          return
        const color = line === selection.line ? colors.current : colors.range
        const marker = line === selection.line ? "▶" : "▎"
        const current = pane.getLineColors()
        if (current.content.get(row) === color && current.gutter.get(row) === color && sign?.before === marker) return
        saved.set(row, { color: { gutter: current.gutter.get(row), content: current.content.get(row) }, sign })
        pane.setLineColor(row, { gutter: color, content: color })
        updates.set(row, { ...sign, before: marker, beforeColor: colors.accent })
      })
      // Every setLineSign recalculates widths across the entire gutter. Batch a
      // selected range so applying its markers is linear rather than quadratic.
      if (updates.size) pane.setLineSigns(new Map([...pane.getLineSigns(), ...updates]))
    })
  }
  return {
    apply,
    clear() {
      applied.clear()
      original.forEach((rows, pane) => {
        if (pane.isDestroyed) return
        const updates = new Map<number, LineSign | undefined>()
        rows.forEach((saved, row) => {
          const color = pane.getLineColors().content.get(row)
          if (color === colors.current || color === colors.range) {
            pane.clearLineColor(row)
            if (saved.color.gutter || saved.color.content) pane.setLineColor(row, saved.color)
          }
          const sign = pane.getLineSigns().get(row)
          if (sign?.beforeColor !== colors.accent) return
          updates.set(row, saved.sign)
        })
        if (updates.size) {
          const signs = new Map(pane.getLineSigns())
          updates.forEach((sign, row) => (sign ? signs.set(row, sign) : signs.delete(row)))
          pane.setLineSigns(signs)
        }
      })
      original.clear()
    },
  }
}

export function annotationPreview(patch: string, side: "old" | "new", start: number, end: number) {
  const header = patch.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/m)
  if (!header) return ""
  let old = Number(header[1])
  let next = Number(header[2])
  return patch
    .slice(patch.indexOf(header[0]))
    .split("\n")
    .flatMap((line) => {
      if (![" ", "+", "-"].includes(line[0])) return []
      const number = side === "old" ? old : next
      const included = side === "old" ? line[0] !== "+" : line[0] !== "-"
      if (line[0] !== "+") old++
      if (line[0] !== "-") next++
      return included && number >= start && number <= end ? [line.slice(1)] : []
    })
    .join("\n")
}

export function annotationLabel(note: DiffAnnotation) {
  return `${note.file}:${note.start}${note.end !== note.start ? `-${note.end}` : ""} (${note.side}, ${note.source})`
}

export function annotationPrompt(
  notes: readonly DiffAnnotation[],
  draft: PromptInfo = { input: "", parts: [] },
): PromptInfo {
  if (!notes.length) return draft
  const count = new Set(notes.map((note) => note.file)).size
  const label = `[Diff annotations: ${notes.length} ${notes.length === 1 ? "comment" : "comments"} · ${count} ${count === 1 ? "file" : "files"}]`
  const start = draft.input.length + (draft.input ? 2 : 0)
  return {
    input: draft.input + (draft.input ? "\n\n" : "") + label,
    mode: "normal",
    parts: [
      ...draft.parts,
      {
        type: "text",
        text:
          "Please address these diff review annotations:\n\n" +
          notes
            .map(
              (note, index) =>
                `${index + 1}. ${annotationLabel(note)}\nComment: ${note.comment}\nSelected code:\n${note.preview
                  .split("\n")
                  .map((line) => `    ${line}`)
                  .join("\n")}`,
            )
            .join("\n\n"),
        metadata: { kind: "diff_annotations" },
        source: { text: { start, end: start + label.length, value: label } },
      },
    ],
  }
}

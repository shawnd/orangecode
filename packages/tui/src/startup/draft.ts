// A display projection only. Editing and handoff retain the original UTF-16
// draft. Match EditBuffer's fixed two-cell tabs and word-wrapped visual lines.
export function startupDraft(
  text: string,
  offset: number,
  width: number,
  segmenter: Intl.Segmenter,
  maxHeight = Infinity,
) {
  const parts = Array.from(segmenter.segment(text), (part) => ({
    text: part.segment === "\t" ? "  " : part.segment,
    index: part.index,
    width: part.segment === "\t" ? 2 : Bun.stringWidth(part.segment),
  }))
  const rows: { text: string; start: number }[] = []
  let start = 0
  let end = 0
  let cells = 0
  let boundary = 0
  const append = (until: number) => {
    const line = parts.slice(start, until)
    rows.push({
      text: line.map((part) => part.text).join(""),
      start: parts[start]?.index ?? text.length,
    })
    start = until
    end = until
    cells = 0
    boundary = until
  }
  while (end < parts.length) {
    const part = parts[end]
    const ideograph = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(part.text)
    if (ideograph) boundary = end
    if (part.text === "\n") {
      append(end)
      start++
      end++
      boundary = start
      continue
    }
    if (cells + part.width > width && end > start) {
      append(boundary > start ? boundary : end)
      continue
    }
    cells += part.width
    end++
    if (/^[\s\-\/.,;:!?\\()[\]{}]$/.test(part.text) || part.text === "  " || ideograph) boundary = end
  }
  append(end)
  let row = 0
  for (let index = 1; index < rows.length; index++) {
    if (rows[index].start > offset) break
    row = index
  }
  const column = parts
    .filter((part) => part.index >= rows[row].start && part.index < offset)
    .reduce((sum, part) => sum + part.width, 0)
  const height = Math.min(rows.length, maxHeight)
  const top = Math.max(0, Math.min(rows.length - height, row - height + 1 + Math.floor(height * 0.2)))
  return { rows: rows.map((row) => row.text), cursor: { row, column }, height, top }
}

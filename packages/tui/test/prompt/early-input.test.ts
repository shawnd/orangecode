import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { adoptEarlyDraft } from "../../src/prompt/early-input"
import { promptOffsetWidth } from "../../src/prompt/display"

test("adopts Unicode and multiline text with the cursor at the same edit boundary, without submitting", async () => {
  const test = await createTestRenderer({ width: 80, height: 24 })
  let submissions = 0
  const input = new TextareaRenderable(test.renderer, {
    id: "draft",
    onSubmit: () => {
      submissions++
    },
  })
  test.renderer.root.add(input)
  try {
    const text = "👩‍💻界\nhelloé!"
    expect(adoptEarlyDraft(input, { text, cursor: text.length - 1 })).toBe(text)
    input.insertText("X")
    expect(input.plainText).toBe("👩‍💻界\nhelloéX!")
    expect(submissions).toBe(0)
  } finally {
    test.renderer.destroy()
  }
})

test("preserves restored text, cursor and attachment extmarks before appending startup typing", async () => {
  const test = await createTestRenderer({ width: 80, height: 24 })
  const input = new TextareaRenderable(test.renderer, { id: "draft", initialValue: "saved @file" })
  test.renderer.root.add(input)
  try {
    const mark = input.extmarks.create({ start: 6, end: 11, virtual: true })
    input.cursorOffset = 3
    expect(adoptEarlyDraft(input, { text: "", cursor: 0 })).toBe("saved @file")
    expect(input.cursorOffset).toBe(3)
    expect(adoptEarlyDraft(input, { text: "new界", cursor: 3 })).toBe("saved @file\nnew界")
    expect(input.extmarks.get(mark)).toMatchObject({ start: 6, end: 11, virtual: true })
    input.insertText("X")
    expect(input.plainText).toBe("saved @file\nnewX界")
  } finally {
    test.renderer.destroy()
  }
})

for (const mode of ["preview", "adopt"] as const) {
  test(`${mode} maps UTF-16 cursor boundaries across tabs, wide Unicode and newlines to actual textarea offsets`, async () => {
    const test = await createTestRenderer({ width: 80, height: 24 })
    const input = new TextareaRenderable(test.renderer, { id: "tabs" })
    test.renderer.root.add(input)
    try {
      for (const text of ["a\tb", "aa\tb", "界\tb", "a\t\tb", "👩‍💻\t界\nx\ty", "\t\n界\t👩‍💻\n\tend"]) {
        const cursors = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)]
          .map((part) => part.index)
          .concat(text.length)
        for (const cursor of cursors) {
          const prefix = mode === "adopt" ? "restored\t界\n" : ""
          if (mode === "adopt") {
            input.setText("restored\t界")
            adoptEarlyDraft(input, { text, cursor })
          } else {
            // Exercise the preview's production conversion against the native
            // textarea, not a second implementation of display widths.
            input.setText(text)
            input.cursorOffset = promptOffsetWidth(text.slice(0, cursor))
          }
          input.insertText("X")
          expect(input.plainText).toBe(prefix + text.slice(0, cursor) + "X" + text.slice(cursor))
        }
      }
    } finally {
      test.renderer.destroy()
    }
  })
}

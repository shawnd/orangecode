import { expect, test } from "bun:test"
import { annotationPreview, annotationPrompt, diffHunks } from "../../src/feature-plugins/system/diff-viewer-review"
import { expandTrackedPastedText } from "../../src/prompt/part"

test("hunk extraction retains patch metadata, omitted counts, and no-newline markers", () => {
  const patch =
    "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n@@ -8,0 +9,2 @@\n+added\n+more"
  const hunks = diffHunks(patch)
  expect(hunks).toHaveLength(2)
  expect(hunks[0].patch).toContain("--- a/file\n+++ b/file")
  expect(hunks[0].patch).not.toContain("added")
  expect(annotationPreview(hunks[0].patch, "old", 1, 1)).toBe("old")
  expect(annotationPreview(hunks[1].patch, "new", 9, 10)).toBe("added\nmore")
  expect(diffHunks("Binary files differ")).toEqual([])
})

test("compact review draft preserves attachment offsets and expands to model-readable comments", () => {
  const draft = {
    input: "Check @file",
    parts: [{ type: "agent" as const, name: "file", source: { start: 6, end: 11, value: "@file" } }],
  }
  const prompt = annotationPrompt(
    [
      {
        id: "a",
        file: "file.ts",
        source: "last turn",
        hunk: "@@ -1 +1 @@",
        side: "new",
        start: 1,
        end: 1,
        preview: "new",
        comment: "Reconsider this",
      },
    ],
    draft,
  )
  expect(prompt.parts[0]).toEqual(draft.parts[0])
  const part = prompt.parts[1]
  if (part.type !== "text" || !part.source) throw new Error("Expected compact annotation part")
  expect(prompt.input.slice(part.source.text.start, part.source.text.end)).toBe(part.source.text.value)
  const expanded = expandTrackedPastedText(prompt.input, [
    { start: part.source.text.start, end: part.source.text.end, text: part.text },
  ])
  expect(expanded).toContain("Check @file\n\nPlease address these diff review annotations:")
  expect(expanded).toContain("file.ts:1 (new, last turn)")
  expect(expanded).toContain("Reconsider this")
  expect(expanded).not.toContain("[Diff annotations:")
  expect(annotationPrompt([], draft)).toBe(draft)
})

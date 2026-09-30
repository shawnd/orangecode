import { expect, test } from "bun:test"
import { applyPatch, createTwoFilesPatch, diffLines, structuredPatch } from "diff"
import { Diff } from "../../src/util/diff"

function baseline(file: string, before: string, after: string) {
  return {
    patch: createTwoFilesPatch(file, file, before, after),
    ...diffLines(before, after).reduce(
      (counts, part) => ({
        additions: counts.additions + (part.added ? part.count : 0),
        deletions: counts.deletions + (part.removed ? part.count : 0),
      }),
      { additions: 0, deletions: 0 },
    ),
  }
}

test("summary preserves baseline patch bytes and counts for headers, EOF and unusual text", () => {
  const cases = [
    ["", ""],
    ["same\n", "same\n"],
    ["", "a"],
    ["a", ""],
    ["a\n", "b\n"],
    ["a", "a\n"],
    ["a\n", "a"],
    ["\r", "\r\n"],
    ["a\r\nb\nc\r", "a\nb\r\nc\r"],
    ["a\n", "z\na\ny\n"],
    ["a\nb\na\nb\na\n", "b\na\nb\na\nb\n"],
    ["\ufeff\0\ud800😀é", "\ufeff\0\udfff😁é\n"],
    [
      Array.from({ length: 60 }, (_, i) => `line${i}\n`).join(""),
      Array.from({ length: 60 }, (_, i) => `${i % 11 ? "line" : "changed"}${i}\n`).join(""),
    ],
  ]
  for (const file of ["file.ts", '空 白\t"😀.ts', "line\nbreak.ts"]) {
    for (const [before, after] of cases) {
      const expected = baseline(file, before, after)
      const summary = Diff.summarize(file, before, after)
      expect(summary).toEqual(expected)
      if (file.includes("\n")) {
        expect(() => applyPatch(before, expected.patch)).toThrow()
        expect(() => applyPatch(before, summary.patch)).toThrow()
        continue
      }
      // jsdiff cannot apply every unusual-text/header patch it creates.
      if (applyPatch(before, expected.patch) === after) expect(applyPatch(before, summary.patch)).toBe(after)
    }
  }
})

test("eight context lines merge hunks while nine separate them without changing counts", () => {
  for (const gap of [8, 9]) {
    const before = `old first\n${"context\n".repeat(gap)}old last\n`
    const after = `new first\n${"context\n".repeat(gap)}new last\n`
    expect(structuredPatch("gap", "gap", before, after).hunks.length).toBe(gap === 8 ? 1 : 2)
    expect(Diff.summarize("gap", before, after)).toEqual(baseline("gap", before, after))
  }
})

test("seeded repeat-rich inputs retain baseline tie choices", () => {
  let seed = 0xdecafbad
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000
  const tokens = ["a\n", "a\n", "b\n", "\n", "a\r\n", "\0\n", "\ud800\n", "😀\n"]
  const text = () =>
    Array.from({ length: Math.floor(random() * 40) }, () => tokens[Math.floor(random() * tokens.length)]).join("") +
    (random() < 0.5 ? "end" : "")
  for (let i = 0; i < 500; i++) {
    const before = text()
    const after = text()
    expect(Diff.summarize("random", before, after)).toEqual(baseline("random", before, after))
  }
})

test("exhaustive short repeated-line and EOF combinations preserve entire summaries", () => {
  const words = [""]
  let level = [""]
  for (let depth = 0; depth < 3; depth++) {
    level = level.flatMap((word) => ["a\n", "b\n", "a"].map((token) => word + token))
    words.push(...level)
  }
  for (const before of words) {
    for (const after of words) {
      expect(Diff.summarize("exhaustive", before, after)).toEqual(baseline("exhaustive", before, after))
    }
  }
})

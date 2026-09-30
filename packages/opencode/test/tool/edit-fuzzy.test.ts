import { expect, test } from "bun:test"
import { BlockAnchorReplacer, replace } from "../../src/tool/edit"
import { FuzzyBaseline } from "./native-fuzzy-baseline"
import leven from "leven"

// The attributed original implementation is frozen alongside these tests, so a
// source archive/shallow checkout exercises the same oracle without Git history.
const oracle = FuzzyBaseline

function outcome(run: () => string) {
  try {
    return { value: run() }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return { error: error.message }
  }
}

const block = (middle: string) => `start\n${middle}\nend`
const threshold = block("a".repeat(20))
const fixtures = [
  { name: "exact threshold", content: block("a".repeat(13) + "b".repeat(7)), find: threshold, accept: true },
  { name: "below threshold", content: block("a".repeat(12) + "b".repeat(8)), find: threshold, accept: false },
  { name: "above threshold", content: block("a".repeat(14) + "b".repeat(6)), find: threshold, accept: true },
  { name: "blank interior contributes zero", content: block("\n"), find: block("\n"), accept: false },
  {
    name: "ECMAScript trim",
    content: `\ufeffstart\u00a0\n\ufeff${"a".repeat(19)}b\u00a0\n end\r`,
    find: threshold,
    accept: true,
  },
  { name: "trailing newline", content: threshold + "\n", find: threshold + "\n", accept: true },
  { name: "CRLF", content: threshold.replaceAll("\n", "\r\n"), find: threshold, accept: true },
  {
    name: "first closing anchor too early",
    content: "start\nx\nend\nx\nx\nx\nend",
    find: "start\nx\nx\nx\nx\nx\nend",
    accept: false,
  },
  { name: "transposition", content: block("0123456789ba"), find: block("0123456789ab"), accept: true },
  {
    name: "surrogates and combining marks",
    content: block("😀\ud800e\u0301abc"),
    find: block("😁\udc00éabc"),
    accept: false,
  },
  {
    name: "early exit after enough contributions",
    content: block("abc\nabc\nwrong"),
    find: block("abc\nabc\nright"),
    accept: true,
  },
  { name: "block length delta", content: block("abc\nabc"), find: block("abc"), accept: true },
]

for (const fixture of fixtures) {
  test(`saved baseline: ${fixture.name}`, () => {
    const expected = [...oracle.BlockAnchorReplacer(fixture.content, fixture.find)]
    expect(expected.length > 0).toBe(fixture.accept)
    expect([...BlockAnchorReplacer(fixture.content, fixture.find)]).toEqual(expected)
    for (const all of [false, true]) {
      expect(outcome(() => replace(fixture.content, fixture.find, "replacement", all))).toEqual(
        outcome(() => oracle.replace(fixture.content, fixture.find, "replacement", all)),
      )
    }
  })
}

test("equal scores choose the first candidate and repeated winners stay ambiguous", () => {
  const first = block("a".repeat(14) + "b".repeat(6))
  const second = block("a".repeat(14) + "c".repeat(6))
  const content = `${first}\n${second}`
  expect([...BlockAnchorReplacer(content, threshold)]).toEqual([first])
  expect([...BlockAnchorReplacer(`${second}\n${first}`, threshold)]).toEqual([second])
  expect(replace(content, threshold, "new")).toBe(`new\n${second}`)
  expect(() => replace(`${first}\n${first}`, threshold, "new")).toThrow(
    "Found multiple matches for oldString. Provide more surrounding context to make the match unique.",
  )
  expect(replace(`${first}\n${first}`, threshold, "$&", true)).toBe(`${first}\n${first}`)
})

test("replacement safeguards and exact errors retain baseline behavior", () => {
  const cases: [string, string, string][] = [
    ["text", "", "new"],
    ["text", "text", "text"],
    ["text", "absent", "new"],
    ["text text", "text", "new"],
    ["start\n" + " ".repeat(600) + "abc\nend", block("abc"), "new"],
    ["start\nabc\n" + "noise\n".repeat(20) + "end", block("abc"), "new"],
  ]
  for (const [content, find, replacement] of cases) {
    for (const all of [false, true]) {
      expect(outcome(() => replace(content, find, replacement, all))).toEqual(
        outcome(() => oracle.replace(content, find, replacement, all)),
      )
    }
  }
})

test("seeded actual candidate and replacement parity with the base revision", () => {
  let seed = 0x5eed
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
  const lines = ["", " ", "\ufeff", "abc", "abd", "abcdef", "😀", "\ud800", "e\u0301", "\u00a0abc\r"]
  const middle = () => Array.from({ length: 1 + (next() % 6) }, () => lines[next() % lines.length]).join("\n")
  for (let i = 0; i < 500; i++) {
    const find = block(middle()) + (next() % 2 ? "\n" : "")
    const content = Array.from({ length: 1 + (next() % 4) }, () => block(middle())).join("\n")
    expect([...BlockAnchorReplacer(content, find)]).toEqual([...oracle.BlockAnchorReplacer(content, find)])
    for (const all of [false, true]) {
      expect(outcome(() => replace(content, find, "new", all))).toEqual(
        outcome(() => oracle.replace(content, find, "new", all)),
      )
    }
  }
})

test("installed distance matches the frozen UTF-16 oracle on an exhaustive bounded corpus", () => {
  const alphabet = ["a", "\u0000", "\ud800", "\udc00"]
  const strings = [""]
  for (let length = 1; length <= 3; length++) {
    strings.push(
      ...strings.filter((value) => value.length === length - 1).flatMap((value) => alphabet.map((c) => value + c)),
    )
  }
  for (const a of strings) {
    for (const b of strings) {
      expect(leven(a, b)).toBe(oracle.levenshtein(a, b))
    }
  }
})

test("installed distance preserves code units, transpositions, affixes, and repeated-call state", () => {
  const saved = [
    ["😀", ""],
    ["😀", "😁"],
    ["\ud800", "\udc00"],
    ["\ud800\udc00", "\udc00\ud800"],
    ["e\u0301", "é"],
    ["ab", "ba"],
    ["\uffff\u0000", "\u0000\uffff"],
    ["a".repeat(1024), "b".repeat(1024)],
    ["prefix".repeat(100) + "😀", "prefix".repeat(100) + "\ud800"],
  ]
  let seed = 0xc0de
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
  const lengths = [0, 1, 2, 3, 15, 31, 32, 33, 63, 64, 65, 127, 128, 129, 256]
  const text = () =>
    String.fromCharCode(...Array.from({ length: lengths[next() % lengths.length] }, () => next() & 0xffff))
  for (const [a, b] of [...saved, ...Array.from({ length: 1000 }, () => [text(), text()])]) {
    const expected = oracle.levenshtein(a, b)
    expect(leven(a, b)).toBe(expected)
    expect(leven(b, a)).toBe(expected)
    expect(leven("\ud800prefix" + a + "suffix\udc00", "\ud800prefix" + b + "suffix\udc00")).toBe(expected)
    expect(leven(a, a)).toBe(0)
  }
})

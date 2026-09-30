import { expect, test } from "bun:test"
import { collapseToolOutput } from "../../src/util/collapse-tool-output"

test("tail previews retain only the latest lines at the exact line limit", () => {
  const output = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n")
  expect(collapseToolOutput(output, 10, 1000, "tail")).toEqual({
    output: Array.from({ length: 10 }, (_, index) => `line ${index + 10}`).join("\n"),
    overflow: true,
  })
  expect(collapseToolOutput("one\ntwo", 2, 100, "tail")).toEqual({ output: "one\ntwo", overflow: false })
})

test("tail character limits preserve the newest output without splitting Unicode code points", () => {
  expect(collapseToolOutput("old output\nlatest 😀😀😀 end", 10, 10, "tail")).toEqual({
    output: "…t 😀😀😀 end",
    overflow: true,
  })
})

test("short tail output stays intact and default head previews keep their existing behavior", () => {
  expect(collapseToolOutput("one\ntwo", 10, 100, "tail")).toEqual({ output: "one\ntwo", overflow: false })
  expect(collapseToolOutput("one\ntwo\nthree", 2, 100)).toEqual({ output: "one\ntwo\n…", overflow: true })
  expect(collapseToolOutput("123456789", 10, 5)).toEqual({ output: "1234…", overflow: true })
})

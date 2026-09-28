import { expect, test } from "bun:test"
import { sessionTotalCost } from "../../src/util/session-cost"

test("includes the current session and every descendant subagent, regardless of list order", () => {
  const sessions = [
    { id: "grandchild", parentID: "child", cost: 0.25 },
    { id: "other", cost: 50 },
    { id: "child", parentID: "parent", cost: 1.5 },
    { id: "parent", cost: 2 },
    { id: "sibling", parentID: "other", cost: 3 },
  ]

  expect(sessionTotalCost("parent", sessions)).toBe(3.75)
  expect(sessionTotalCost("child", sessions)).toBe(1.75)
})

test("handles missing costs and sessions not loaded in the list", () => {
  expect(sessionTotalCost("parent", [{ id: "child", parentID: "parent", cost: 0.5 }])).toBe(0.5)
  expect(sessionTotalCost("parent", [{ id: "parent" }])).toBe(0)
})

test("includes older subagents outside the cached session list without double-counting live updates", () => {
  const cached = [
    { id: "parent", cost: 2 },
    { id: "recent", parentID: "parent", cost: 3 },
  ]
  const loaded = [
    { id: "recent", parentID: "parent", cost: 1 },
    { id: "old", parentID: "parent", cost: 4 },
    { id: "nested", parentID: "old", cost: 0.25 },
  ]

  expect(sessionTotalCost("parent", cached, loaded)).toBe(9.25)
})

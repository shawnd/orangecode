import { expect, test } from "bun:test"
import { usageStart } from "./usage-stats"

test("time spans are rolling windows with all time as the default", () => {
  const now = Date.UTC(2026, 8, 30, 12)
  const day = 24 * 60 * 60 * 1000
  expect(usageStart("all", now)).toBeUndefined()
  expect(usageStart("1d", now)).toBe(now - day)
  expect(usageStart("1w", now)).toBe(now - 7 * day)
  expect(usageStart("1m", now)).toBe(now - 30 * day)
  expect(usageStart("1y", now)).toBe(now - 365 * day)
})

export const usagePeriods = [
  { id: "1d", days: 1 },
  { id: "1w", days: 7 },
  { id: "1m", days: 30 },
  { id: "1y", days: 365 },
  { id: "all", days: undefined },
] as const

export type UsagePeriod = (typeof usagePeriods)[number]["id"]

export function usageStart(period: UsagePeriod, now: number) {
  const days = usagePeriods.find((item) => item.id === period)?.days
  return days === undefined ? undefined : now - days * 24 * 60 * 60 * 1000
}

export function sessionTotalCost(
  sessionID: string,
  sessions: readonly { id: string; parentID?: string; cost?: number }[],
  historical: readonly { id: string; parentID?: string; cost?: number }[] = [],
) {
  const all = [...new Map([...historical, ...sessions].map((session) => [session.id, session] as const)).values()]
  const children = new Map<string, string[]>()
  const costs = new Map(all.map((session) => [session.id, session.cost ?? 0] as const))
  for (const session of all) {
    if (!session.parentID) continue
    children.set(session.parentID, [...(children.get(session.parentID) ?? []), session.id])
  }

  const visited = new Set<string>()
  const pending = [sessionID]
  let total = 0
  while (pending.length) {
    const id = pending.pop()
    if (!id || visited.has(id)) continue
    visited.add(id)
    total += costs.get(id) ?? 0
    pending.push(...(children.get(id) ?? []))
  }
  return total
}

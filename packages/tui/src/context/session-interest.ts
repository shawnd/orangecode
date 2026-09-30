// Viewing and authority are deliberately separate. Only an explicit local
// submission grants automatic-approval authority; summaries never grant it.
export function createSessionInterest(selective = true) {
  const parents = new Map<string, string | undefined>()
  const controlled = new Set<string>()
  const active = new Set<string>()
  let selected: string | undefined
  const changes = new Set<() => void>()
  const notify = () => changes.forEach((fn) => fn())
  function belongs(sessionID: string, roots: Set<string>) {
    const seen = new Set<string>()
    for (let id: string | undefined = sessionID; id && !seen.has(id); id = parents.get(id)) {
      if (roots.has(id)) return true
      seen.add(id)
    }
    return false
  }
  return {
    select(sessionID?: string) {
      if (selected === sessionID) return
      selected = sessionID
      notify()
    },
    control(sessionID: string) {
      controlled.add(sessionID)
      active.add(sessionID)
      notify()
    },
    observe(info: { id: string; parentID?: string }) {
      parents.set(info.id, info.parentID)
    },
    status(sessionID: string, busy: boolean) {
      if (!controlled.has(sessionID)) return
      if (busy === active.has(sessionID)) return
      if (busy) active.add(sessionID)
      if (!busy) active.delete(sessionID)
      notify()
    },
    owns(sessionID: string) {
      return belongs(sessionID, controlled)
    },
    includes(sessionID: string) {
      if (!selective) return true
      return belongs(sessionID, new Set([...active, ...(selected ? [selected] : [])]))
    },
    query() {
      return [...new Set([...active, ...(selected ? [selected] : [])])].sort().join(",")
    },
    onChange(fn: () => void) {
      changes.add(fn)
      return () => changes.delete(fn)
    },
  }
}

// Viewing and authority are deliberately separate. Only an explicit local
// submission grants automatic-approval authority; summaries never grant it.
export function createSessionInterest(selective = true) {
  const parents = new Map<string, string | undefined>()
  const controlled = new Set<string>()
  const active = new Set<string>()
  const submitting = new Map<string, number>()
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
      if (controlled.has(sessionID) && active.has(sessionID)) return
      controlled.add(sessionID)
      active.add(sessionID)
      notify()
    },
    holdSubmission(sessionID: string) {
      submitting.set(sessionID, (submitting.get(sessionID) ?? 0) + 1)
      return () => {
        const remaining = (submitting.get(sessionID) ?? 1) - 1
        if (remaining === 0) submitting.delete(sessionID)
        if (remaining > 0) submitting.set(sessionID, remaining)
      }
    },
    observe(info: { id: string; parentID?: string }, notifyChange = true) {
      const included = belongs(info.id, new Set([...active, ...(selected ? [selected] : [])]))
      parents.set(info.id, info.parentID)
      if (notifyChange && included !== belongs(info.id, new Set([...active, ...(selected ? [selected] : [])]))) notify()
    },
    status(sessionID: string, busy: boolean) {
      if (!belongs(sessionID, controlled)) return
      if (busy === active.has(sessionID)) return
      if (busy) active.add(sessionID)
      if (!busy) active.delete(sessionID)
      notify()
    },
    reconcileStatus(statuses: Record<string, { type: string }>) {
      const previous = [...active].sort().join(",")
      // Recovery can observe idle before a readiness-blocked POST is dispatched.
      // Keep that interest until all waiting submissions have left the barrier.
      for (const id of active) {
        if (!submitting.has(id) && (!statuses[id] || statuses[id].type === "idle")) active.delete(id)
      }
      for (const [id, status] of Object.entries(statuses)) {
        if (status.type !== "idle" && belongs(id, controlled)) active.add(id)
      }
      if (previous !== [...active].sort().join(",")) notify()
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

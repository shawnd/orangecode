export * as Diff from "./diff"

import { formatPatch, structuredPatch } from "diff"

/** One line-diff pass supplies both the displayed patch and its counts. */
export function summarize(file: string, before: string, after: string) {
  const patch = structuredPatch(file, file, before, after)
  let additions = 0
  let deletions = 0
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line[0] === "+") additions++
      if (line[0] === "-") deletions++
    }
  }
  // formatPatch mutates zero-length hunk starts; format exactly once.
  return { patch: formatPatch(patch), additions, deletions }
}

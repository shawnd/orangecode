export * as CliSkills from "./cli-skills"

export const instructions = [
  "# CLI Skills",
  "When Herdr is mentioned in the conversation or attached context, run `herdr --skill` before proceeding unless its output is already present in the current context. Follow the returned instructions. After compaction, run it again when Herdr remains relevant; a summary of an earlier invocation does not count as loaded skill output.",
].join("\n")

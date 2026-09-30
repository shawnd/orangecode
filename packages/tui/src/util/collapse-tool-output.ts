export function collapseToolOutput(
  output: string,
  maxLines: number,
  maxChars: number,
  direction: "head" | "tail" = "head",
) {
  const lines = output.split("\n")
  if (lines.length <= maxLines && Array.from(output).length <= maxChars) {
    return { output, overflow: false }
  }

  const preview = (direction === "tail" ? lines.slice(-maxLines) : lines.slice(0, maxLines)).join("\n")
  if (direction === "tail") {
    const chars = Array.from(preview)
    return {
      output:
        chars.length > maxChars
          ? "…" + chars.slice(Math.max(0, chars.length - Math.max(0, maxChars - 1))).join("")
          : preview,
      overflow: true,
    }
  }
  if (Array.from(preview).length > maxChars) {
    return {
      output:
        Array.from(preview)
          .slice(0, Math.max(0, maxChars - 1))
          .join("") + "…",
      overflow: true,
    }
  }

  return { output: [...lines.slice(0, maxLines), "…"].join("\n"), overflow: true }
}

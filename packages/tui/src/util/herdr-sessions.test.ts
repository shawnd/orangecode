import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseHerdrCommand } from "./herdr-sessions"

test("Herdr scope parsing accepts explicit scopes and rejects extra arguments", () => {
  expect(parseHerdrCommand(" /herdr ")?.scope).toBeUndefined()
  expect(parseHerdrCommand("/herdr\tworkspace")?.scope).toBe("workspace")
  expect(parseHerdrCommand("/herdr tab")?.scope).toBe("tab")
  expect(parseHerdrCommand("/herdr all")?.scope).toBe("all")
  expect(parseHerdrCommand("/herdr all extra")?.error).toContain("Usage:")
  expect(parseHerdrCommand("/herdr\nworkspace\nall")?.error).toContain("Usage:")
  expect(parseHerdrCommand("/herd")).toBeUndefined()
})

for (const scope of [
  "tab",
  "workspace",
  "all",
  "outside",
  "failure",
  "invalid",
  "json",
  "identity",
  "inventory",
  "missing",
  "empty",
  "fallback",
  "timeout",
] as const) {
  test(`Herdr inventory through the CLI boundary: ${scope}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opencode-herdr-sessions-"))
    try {
      const caller = {
        pane_id: "moved:p1",
        tab_id: "moved:t1",
        workspace_id: "moved",
        agent: "opencode",
        agent_status: "working",
        terminal_title_stripped: "OC | Current task",
        cwd: "/repo",
        foreground_cwd: "/repo/two  spaces\tand tab",
        agent_session: { agent: "opencode", kind: "id", value: "ses_current" },
      }
      const inventories = {
        pane: {
          panes: [
            caller,
            {
              ...caller,
              pane_id: "moved:p2",
              agent_status: "blocked",
              terminal_title_stripped: "OC | Waiting",
              agent_session: undefined,
            },
            {
              ...caller,
              pane_id: "moved:p3",
              tab_id: "moved:t2",
              agent_status: "done",
              terminal_title_stripped: "OC | Finished",
              agent_session: { agent: "opencode", kind: "id", value: "ses_finished" },
            },
            {
              ...caller,
              pane_id: "other:p1",
              tab_id: "other:t1",
              workspace_id: "other",
              focused: true,
              agent_status: "idle",
              terminal_title_stripped: "OC | Other workspace",
              agent_session: { agent: "opencode", kind: "id", value: "ses_other" },
            },
            { pane_id: "moved:shell", tab_id: "moved:t1", workspace_id: "moved", cwd: "/repo" },
            {
              ...caller,
              pane_id: "other:claude",
              tab_id: "other:t1",
              workspace_id: "other",
              agent: "claude",
              agent_session: { agent: "claude", kind: "id", value: "claude_session" },
            },
          ],
        },
        tab: {
          tabs: [
            { tab_id: "moved:t1", label: "Current tab" },
            { tab_id: "moved:t2", label: "Background tab" },
            { tab_id: "other:t1", label: "Focused elsewhere" },
          ],
        },
        workspace: {
          workspaces: [
            { workspace_id: "moved", label: "Moved workspace" },
            { workspace_id: "other", label: "Other workspace" },
          ],
        },
      }
      await Bun.write(
        path.join(directory, "herdr"),
        `#!${process.execPath}
import { appendFileSync } from "node:fs"
const args = process.argv.slice(2)
appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + "\\n")
if (process.env.SCENARIO === "failure") { console.error("Herdr server unavailable"); process.exit(1) }
if (process.env.SCENARIO === "timeout") await Bun.sleep(60_000)
if (process.env.SCENARIO === "json") { console.log("{"); process.exit(0) }
const inventories = ${JSON.stringify(inventories)}
if (process.env.SCENARIO === "empty") inventories.pane.panes = inventories.pane.panes.filter((pane) => !pane.agent)
if (process.env.SCENARIO === "fallback") {
  inventories.pane.panes = [{ pane_id: "moved:p1", tab_id: "moved:t1", workspace_id: "moved", agent: "opencode", cwd: "/repo/raw  spaces", terminal_title: "OC | fallback  title" }]
  inventories.tab.tabs = []
  inventories.workspace.workspaces = []
}
const result = args[1] === "current" ? { pane: ${JSON.stringify(caller)} } : inventories[args[0]]
if (process.env.SCENARIO === "identity" && result.pane) result.pane.pane_id = ""
if (process.env.SCENARIO === "inventory" && result.panes) result.panes = "invalid"
console.log(process.env.SCENARIO === "invalid" ? JSON.stringify({ result: { panes: [] } }) : JSON.stringify({ result }))
`,
      )
      if (scope !== "missing") await chmod(path.join(directory, "herdr"), 0o755)
      await Bun.write(
        path.join(directory, "runner.ts"),
        `import { gatherHerdrSessions } from ${JSON.stringify(path.join(import.meta.dir, "herdr-sessions.ts"))}
console.log(JSON.stringify(await gatherHerdrSessions(${JSON.stringify(scope === "workspace" || scope === "all" ? scope : "tab")}, "ses_current")))
`,
      )
      const child = Bun.spawn([process.execPath, path.join(directory, "runner.ts")], {
        env: {
          ...process.env,
          PATH: scope === "missing" ? "/nonexistent-herdr-path" : `${directory}:${process.env.PATH}`,
          HERDR_ENV: scope === "outside" ? "" : "1",
          HERDR_PANE_ID: "stale:p1",
          HERDR_TAB_ID: "stale:t1",
          HERDR_WORKSPACE_ID: "stale",
          SCENARIO: scope,
          CALL_LOG: path.join(directory, "calls"),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      const errors = {
        outside: "/herdr requires a Herdr pane",
        failure: "Herdr server unavailable",
        invalid: "Herdr did not return the current pane",
        json: "JSON Parse error",
        identity: "Invalid Herdr pane identity",
        inventory: "Invalid Herdr inventory",
        missing: "Herdr is not available in PATH",
        timeout: "Herdr exited with status",
      }
      if (scope in errors) {
        expect(code).not.toBe(0)
        expect(stderr).toContain(errors[scope as keyof typeof errors])
        if (scope === "outside" || scope === "missing")
          expect(await Bun.file(path.join(directory, "calls")).exists()).toBe(false)
        return
      }
      expect(code).toBe(0)
      const snapshot = JSON.parse(stdout)
      if (scope === "empty") {
        expect(snapshot.count).toBe(0)
        expect(snapshot.text).toContain("0 OpenCode panes · 0 reported sessions · 1 total panes")
        expect(snapshot.text).toContain("No OpenCode panes found in this scope.")
        return
      }
      if (scope === "fallback") {
        expect(snapshot.count).toBe(1)
        expect(snapshot.text).toContain('Workspace "moved" (moved)')
        expect(snapshot.text).toContain('Tab "moved:t1" (moved:t1)')
        expect(snapshot.text).toContain("moved:p1 · unknown · this pane")
        expect(snapshot.text).toContain('Title: "fallback  title"')
        expect(snapshot.text).toContain('Directory: "/repo/raw  spaces"')
        expect(snapshot.text).toContain("Session: not reported")
        return
      }
      expect(snapshot.count).toBe(scope === "tab" ? 2 : scope === "workspace" ? 3 : 4)
      expect(snapshot.text).toContain('Workspace "Moved workspace" (moved)')
      expect(snapshot.text).toContain('Tab "Current tab" (moved:t1)')
      expect(snapshot.text).toContain("moved:p1 · working · this pane · this session")
      expect(snapshot.text).toContain(`Directory: ${JSON.stringify(caller.foreground_cwd)}`)
      expect(snapshot.text).toContain(`${snapshot.count} OpenCode panes · ${snapshot.count - 1} reported sessions`)
      expect(snapshot.text).toContain(
        scope === "tab"
          ? "1 working, 1 blocked"
          : scope === "workspace"
            ? "1 working, 1 blocked, 1 done"
            : "1 working, 1 blocked, 1 done, 1 idle",
      )
      expect(snapshot.text).toContain("Session: not reported")
      expect(snapshot.text).toContain("moved:p2 · blocked")
      expect(snapshot.text).not.toContain("claude_session")
      expect(snapshot.text).not.toContain("moved:shell")
      expect(snapshot.text.includes("ses_finished")).toBe(scope !== "tab")
      expect(snapshot.text.includes("ses_other")).toBe(scope === "all")
      const calls = (await Bun.file(path.join(directory, "calls")).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(calls).toContainEqual(["pane", "current", "--current"])
      expect(calls).toContainEqual(["pane", "list"])
      expect(calls).toHaveLength(4)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)
}

import { expect, test } from "bun:test"
import { configuredPermissionRules, orderedPermissionRules, permissionActionPatch } from "./permission-rules"

test("editing keeps raw home aliases distinct and sends only the selected leaf", () => {
  const config = {
    external_directory: { "~/work/*": "allow", "$HOME/work/*": "deny", "/home/me/work/*": "ask" },
    bash: "ask",
  } as const
  const rules = configuredPermissionRules(config)
  expect(rules.map((rule) => rule.pattern)).toEqual(["~/work/*", "$HOME/work/*", "/home/me/work/*", "*"])
  expect(permissionActionPatch(config, rules[1], "allow")).toEqual({
    permission: { external_directory: { "$HOME/work/*": "allow" } },
  })
  expect(config.external_directory["$HOME/work/*"]).toBe("deny")
})

test("shorthand edits remain shorthand without replacing neighboring pattern rules", () => {
  const config = { bash: "ask", read: { "*": "allow", "*.env": "deny" } } as const
  expect(permissionActionPatch(config, configuredPermissionRules(config)[0], "deny")).toEqual({
    permission: { bash: "deny" },
  })
  expect(permissionActionPatch("ask", configuredPermissionRules("ask")[0], "allow")).toEqual({
    permission: { "*": "allow" },
  })
})

test("stale or deleted rules cannot be silently overwritten", () => {
  const rule = { permission: "bash", pattern: "*", action: "ask" } as const
  expect(() => permissionActionPatch({ bash: "deny" }, rule, "allow")).toThrow("This rule changed")
  expect(() => permissionActionPatch({}, rule, "allow")).toThrow("This rule changed")
})

test("display follows evaluation order despite HTTP key ordering and expanded aliases", () => {
  const config = { external_directory: { "~/work/*": "allow", "$HOME/work/*": "deny" }, custom_tool: "ask" } as const
  const order = [
    { permission: "custom_tool", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "/remote/home/work/*", action: "allow" },
    { permission: "external_directory", pattern: "/remote/home/work/*", action: "deny" },
  ] as const
  expect(orderedPermissionRules(config, [...order], "/remote/home")).toEqual([
    { permission: "custom_tool", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "~/work/*", action: "allow" },
    { permission: "external_directory", pattern: "$HOME/work/*", action: "deny" },
  ])
})

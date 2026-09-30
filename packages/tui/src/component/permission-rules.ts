import type { PermissionConfig, PermissionRule } from "@opencode-ai/sdk/v2"

// Config keys are deliberately kept raw: expanding ~/ or $HOME would make an
// edit append a different key, changing precedence instead of editing the rule.
export function configuredPermissionRules(config: PermissionConfig | undefined): PermissionRule[] {
  if (!config) return []
  if (typeof config === "string") return [{ permission: "*", pattern: "*", action: config }]
  return Object.entries(config).flatMap(([permission, value]) => {
    if (!value) return []
    if (typeof value === "string") return [{ permission, pattern: "*", action: value }]
    return Object.entries(value).map(([pattern, action]) => ({ permission, pattern, action }))
  })
}

export function orderedPermissionRules(config: PermissionConfig | undefined, order: PermissionRule[], home: string) {
  const remaining = configuredPermissionRules(config)
  // Config's HTTP schema can emit known tool keys before custom keys. The status
  // endpoint carries evaluation order; join back to raw keys without losing aliases.
  return order.map((rule) => {
    const index = remaining.findIndex((item) => {
      const pattern =
        item.pattern === "~" || item.pattern.startsWith("~/")
          ? home + item.pattern.slice(1)
          : item.pattern.startsWith("$HOME")
            ? home + item.pattern.slice(5)
            : item.pattern
      return item.permission === rule.permission && item.action === rule.action && pattern === rule.pattern
    })
    if (index === -1) throw new Error("Configuration changed while loading. Refresh to retry.")
    return remaining.splice(index, 1)[0]
  })
}

export function permissionActionPatch(
  config: PermissionConfig | undefined,
  rule: PermissionRule,
  action: PermissionRule["action"],
) {
  const current = configuredPermissionRules(config).find(
    (item) => item.permission === rule.permission && item.pattern === rule.pattern,
  )
  if (!current || current.action !== rule.action) throw new Error("This rule changed. Refresh and select it again.")
  const value = typeof config === "string" ? config : config?.[rule.permission]
  return {
    permission: {
      [rule.permission]: typeof value === "string" ? action : { [rule.pattern]: action },
    },
  }
}

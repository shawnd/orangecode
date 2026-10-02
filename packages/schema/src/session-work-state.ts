export * as SessionWorkState from "./session-work-state"

import { Schema } from "effect"
import { NonNegativeInt } from "./schema"

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  type: Schema.Literals(["idle", "working", "blocked"]).annotate({
    description: "Aggregate subtree activity. Pending interactions take precedence over active work.",
  }),
  foreground: Schema.Literals(["idle", "working"]).annotate({
    description: "Execution status of the requested session only, excluding descendants and detached shells.",
  }),
  agents: NonNegativeInt.annotate({ description: "Number of distinct active descendant agent sessions." }),
  shells: NonNegativeInt.annotate({ description: "Number of running detached shell jobs in the subtree." }),
}).annotate({ identifier: "SessionWorkState.Info" })

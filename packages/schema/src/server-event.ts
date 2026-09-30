export * as ServerEvent from "./server-event"

import { Event } from "./event"
import { Schema } from "effect"
import { optional } from "./schema"

export const Connected = Event.define({
  type: "server.connected",
  schema: {
    sessions: Schema.Array(Schema.Struct({ id: Schema.String, parentID: Schema.NullOr(Schema.String) })).pipe(optional),
  },
})
export const Disposed = Event.define({ type: "global.disposed", schema: {} })

export const Definitions = Event.inventory(Connected, Disposed)

import { FffError } from "./fff-types"
import type { Init, Picker } from "./fff-types"

export type * from "./fff-types"
export { FffError } from "./fff-types"

export function available() {
  return false
}

export function create(_opts: Init): Picker {
  throw new FffError("unavailable", "fff unavailable on node runtime")
}

export function createWorker(opts: Init): Picker {
  return create(opts)
}
export function createDirect(opts: Init): Picker {
  return create(opts)
}

export * as Fff from "./fff.node"

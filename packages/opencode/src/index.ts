import { startEarlyInput, stopEarlyInput } from "./cli/early-input"

startEarlyInput()
try {
  await import("./cli/main")
} finally {
  await stopEarlyInput()
}

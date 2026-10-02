import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { createPromptMode } from "../../src/prompt/mode"

test("cycles terminal, plan, and build in both directions while preserving the backing agent", () => {
  const [agent, setAgent] = createSignal("build")
  const prompt = createPromptMode(() => ["build", "plan"], agent, setAgent)
  prompt.move(1)
  expect(prompt.mode()).toBe("shell")
  expect(agent()).toBe("build")
  prompt.move(1)
  expect(prompt.mode()).toBe("normal")
  expect(agent()).toBe("plan")
  prompt.move(1)
  expect(agent()).toBe("build")
  prompt.move(-1)
  expect(agent()).toBe("plan")
  prompt.move(-1)
  expect(prompt.mode()).toBe("shell")
  prompt.move(-1)
  expect(prompt.mode()).toBe("normal")
  expect(agent()).toBe("build")
})

test("keeps custom primary agents in the cycle and skips absent built-ins", () => {
  const [agent, setAgent] = createSignal("custom")
  const prompt = createPromptMode(() => ["custom", "build", "review"], agent, setAgent)
  prompt.setMode("shell")
  prompt.move(1)
  expect(agent()).toBe("build")
  prompt.move(1)
  expect(agent()).toBe("custom")
  prompt.move(1)
  expect(agent()).toBe("review")
  prompt.move(1)
  expect(prompt.mode()).toBe("shell")
})

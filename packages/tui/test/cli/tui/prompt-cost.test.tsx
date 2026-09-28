/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { SessionCost } from "../../../src/component/prompt/cost"

test("clicking cost toggles between total subagent cost and session-only cost", async () => {
  const [historical, setHistorical] = createSignal([{ id: "child", parentID: "parent", cost: 1.5 }])
  const app = await testRender(
    () => (
      <SessionCost
        sessionID="parent"
        sessionCost={2}
        sessions={[{ id: "parent", cost: 2 }]}
        historical={historical()}
        color={RGBA.fromHex("#ffffff")}
      />
    ),
    { width: 40, height: 3 },
  )

  try {
    await app.flush()
    expect(app.captureCharFrame()).toContain("total $3.50")

    await app.mockMouse.click(5, 0)
    await app.flush()
    expect(app.captureCharFrame()).toContain("session $2.00")

    await app.mockMouse.click(5, 0)
    await app.flush()
    expect(app.captureCharFrame()).toContain("total $3.50")

    setHistorical([{ id: "child", parentID: "parent", cost: 2.5 }])
    await app.flush()
    expect(app.captureCharFrame()).toContain("total $4.50")
  } finally {
    app.renderer.destroy()
  }
})

test("shows zero total cost for a fork before its first new turn", async () => {
  const [cost, setCost] = createSignal(0)
  const app = await testRender(
    () => (
      <SessionCost
        sessionID="fork"
        sessionCost={cost()}
        sessions={[{ id: "fork", cost: cost() }]}
        color={RGBA.fromHex("#ffffff")}
      />
    ),
    { width: 40, height: 3 },
  )

  try {
    await app.flush()
    expect(app.captureCharFrame()).toContain("total $0.00")
    setCost(0.4)
    await app.flush()
    expect(app.captureCharFrame()).toContain("total $0.40")
  } finally {
    app.renderer.destroy()
  }
})

import { expect, test } from "bun:test"
import { ActivityGyro, CELLS, type AgentActivity } from "./gyro"

const run = (gyro: ActivityGyro, seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 60) {
    gyro.step(1 / 60)
    gyro.render(1 / 60)

    if (gyro.isResting) return t
  }

  return Infinity
}

test("the orb is a 7 × 7 grid masked to a disc", () => {
  expect(CELLS.length).toBe(37)
})

test("running keeps moving; done and failed flash, settle and rest", () => {
  const gyro = new ActivityGyro("thinking", false, 1)
  expect(run(gyro, 3)).toBe(Infinity)

  for (const final of ["done", "failed"] satisfies AgentActivity[]) {
    gyro.set("thinking")
    run(gyro, 1)
    gyro.set(final)
    const field = gyro.render(0)
    expect(field.dots.length).toBe(CELLS.length)
    expect(run(gyro, 8)).toBeLessThan(8)
  }
})

test("reduced motion holds a still pose for every state", () => {
  const states: AgentActivity[] = ["idle", "startup", "thinking", "longWork", "tool", "streaming", "waiting", "handoff"]

  for (const state of states) {
    const gyro = new ActivityGyro("thinking", true)
    gyro.set(state)
    expect(run(gyro, 4)).toBeLessThan(4)
  }
})

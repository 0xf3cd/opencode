import { describe, expect, test } from "bun:test"
import { createRowGrowth } from "./row-growth"

function setup() {
  const wrapper = document.createElement("div")
  const sizes: number[] = []
  const frames: { pending: number; held: number }[] = []

  const growth = createRowGrowth({
    measure: () => {},
    resize: (key, size) => {
      if (key !== "row") return false
      sizes.push(size)

      return wrapper
    },
    settle: (state) => frames.push(state),
  })

  return { growth, sizes, wrapper, frames }
}

async function settle(growth: ReturnType<typeof createRowGrowth>) {
  const deadline = performance.now() + 3000

  while (growth.target("row") !== undefined && performance.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 16))
}

describe("row growth", () => {
  test("eases a row to its measured height in whole pixels, behind a soft edge that clears when it lands", async () => {
    const { growth, sizes, wrapper } = setup()
    growth.grow("row", 0, 120)
    expect(growth.target("row")).toBe(120)

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(wrapper.style.getPropertyValue("mask-image")).toContain("linear-gradient")

    await settle(growth)
    expect(growth.target("row")).toBeUndefined()
    expect(sizes.at(-1)).toBe(120)
    expect(sizes.every((size, index) => Number.isInteger(size) && size >= (sizes[index - 1] ?? 0))).toBe(true)
    expect(wrapper.style.getPropertyValue("mask-image")).toBe("")
  })

  test("bends a running growth toward a new height instead of restarting it", async () => {
    const { growth, sizes } = setup()
    growth.grow("row", 0, 100)
    await new Promise((resolve) => setTimeout(resolve, 80))
    const reached = sizes.at(-1) ?? 0
    growth.grow("row", 0, 200)

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(sizes.at(-1)).toBeGreaterThanOrEqual(reached)

    await settle(growth)
    expect(sizes.at(-1)).toBe(200)
  })

  test("reports once per frame how far the rows still have to grow", async () => {
    const { growth, frames } = setup()
    growth.grow("row", 0, 80)

    await settle(growth)
    expect(frames[0]!.pending).toBeGreaterThan(0)
    expect(frames.at(-1)).toEqual({ pending: 0, held: 0 })
    expect(frames.every((frame, index) => frame.pending <= (frames[index - 1]?.pending ?? Infinity))).toBe(true)
  })

  test("closes a held gap on the same spring", async () => {
    const { growth, frames } = setup()
    growth.hold(40)

    const deadline = performance.now() + 3000

    while (frames.at(-1)?.held !== 0 && performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 16))
    expect(frames[0]!.held).toBeGreaterThan(0)
    expect(frames[0]!.held).toBeLessThanOrEqual(40)
    expect(frames.at(-1)!.held).toBe(0)
    expect(frames.every((frame, index) => frame.held <= (frames[index - 1]?.held ?? 40))).toBe(true)
  })

  test("lands rows at once", () => {
    const { growth, sizes, wrapper } = setup()
    growth.grow("row", 10, 300)
    growth.land("row", 280)
    expect(sizes.at(-1)).toBe(280)
    expect(growth.target("row")).toBeUndefined()

    growth.grow("row", 0, 90)
    growth.finish()
    expect(sizes.at(-1)).toBe(90)
    expect(growth.target("row")).toBeUndefined()
    expect(wrapper.style.getPropertyValue("mask-image")).toBe("")
  })
})

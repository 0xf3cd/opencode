import { expect, story } from "../../storybook/playwright/story"

story("opens the batch's rows from the chip and closes with Escape", async ({ mount, page }) => {
  await mount("session-agent-progress-chip--nineteen")
  const chip = page.locator('[data-slot="agent-progress-chip"]')
  const panel = page.getByRole("group", { name: "Subagents" })

  await expect(chip).toHaveAccessibleName("14 of 19 done · 1 failed · 1 needs you")
  await expect(chip).toHaveAttribute("aria-expanded", "false")

  await chip.click()
  await expect(chip).toHaveAttribute("aria-expanded", "true")
  await expect(panel.getByRole("button", { name: "Review", exact: true })).toBeVisible()
  await expect(panel.getByText("Provider rate limit")).toBeVisible()
  await expect(panel.getByRole("button", { name: "Interrupt subagent" })).toHaveCount(3)

  const done = panel.getByRole("button", { name: "14 done", exact: true })
  await expect(done).toHaveAttribute("aria-expanded", "false")
  await done.click()
  await expect(done).toHaveAttribute("aria-expanded", "true")
  await expect(panel.locator('[data-slot="agent-progress-row"][data-state="done"]')).toHaveCount(14)

  await page.keyboard.press("Escape")
  await expect(chip).toHaveAttribute("aria-expanded", "false")
  await expect(chip).toBeFocused()
})

story("counts follow the batch as subagents finish, fail and need input", async ({ mount, page }) => {
  await mount("session-agent-progress-chip--live")
  const chip = page.locator('[data-slot="agent-progress-chip"]')

  const run = (action: string, value?: number) =>
    page.evaluate((detail) => document.dispatchEvent(new CustomEvent("agent-chip-story", { detail })), {
      action,
      value,
    })

  await run("add", 3)
  await expect(chip).toHaveAccessibleName("3 running")
  await run("finish")
  await expect(chip).toHaveAccessibleName("1 of 3 done")
  await run("fail")
  await expect(chip).toHaveAccessibleName("1 of 3 done · 1 failed")
  await run("needs")
  await expect(chip).toHaveAccessibleName("1 of 3 done · 1 failed · 1 needs you")
  await run("finishAll")
  await expect(chip).toHaveAccessibleName("2 of 3 done · 1 failed")
  await run("clear")
  await expect(chip).toHaveCount(0)
})

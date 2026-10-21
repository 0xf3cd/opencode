import { chromium } from "@playwright/test"
import { spawn } from "node:child_process"
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs"
import path from "node:path"

const port = 6431
const out = path.resolve(process.argv[2] ?? "captures/chip-capsule")
const base = `http://127.0.0.1:${port}/iframe.html?viewMode=story&id=session-activity-chips--`
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const server = spawn(
  "bun",
  ["run", "--cwd", "packages/storybook", "storybook", "--", "--port", String(port), "--ci", "--no-open"],
  { stdio: ["ignore", "pipe", "pipe"], detached: true },
)
server.stderr.on("data", (chunk) => process.stderr.write(chunk))

const kill = () => {
  try {
    process.kill(-server.pid!, "SIGTERM")
  } catch {}
}
process.on("exit", kill)

const deadline = Date.now() + 240_000
while (Date.now() < deadline) {
  const ok = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok, () => false)
  if (ok) break
  await Bun.sleep(1000)
}

const browser = await chromium.launch()

const open = async (page: import("@playwright/test").Page, story: string, chips: number) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(String(error)))
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()))
  // Warm the dependency optimizer: the first load can reload once.
  for (let attempt = 0; attempt < 4; attempt++) {
    const ok = await page.goto(base + story, { waitUntil: "domcontentloaded", timeout: 90_000 }).then(
      () => true,
      () => false,
    )
    await page.waitForTimeout(3000)
    if (ok && attempt > 0) break
  }
  await page
    .locator('[data-slot="session-activity-chip"]')
    .nth(chips - 1)
    .waitFor({ timeout: 60_000 })
    .catch(async (error) => {
      console.error(errors.join("\n"))
      await page.screenshot({ path: path.join(out, `error-${story}.png`) })
      throw error
    })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(1200)
  if (errors.length) console.error(`[${story}]`, errors.join("\n"))
}

// 1. Still grid, light and dark side by side.
{
  const page = await browser.newPage({ viewport: { width: 1680, height: 420 }, deviceScaleFactor: 2 })
  await open(page, "capsule-options", 24)
  await page.screenshot({ path: path.join(out, "grid.png"), fullPage: true })

  // Geometry: height, radius, and how far the glyph's centre sits from the start cap's centre.
  const geometry = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-slot="session-activity-chip"]')].map((chip) => {
      const rect = chip.getBoundingClientRect()
      const glyph = chip.firstElementChild!.getBoundingClientRect()
      const radius = Math.min(parseFloat(getComputedStyle(chip).borderTopLeftRadius), rect.height / 2)

      return {
        scheme: chip.closest("[data-color-scheme]")?.getAttribute("data-color-scheme"),
        variant: chip.dataset.variant,
        label: chip.getAttribute("aria-label"),
        width: +rect.width.toFixed(2),
        height: +rect.height.toFixed(2),
        radius,
        border: getComputedStyle(chip).borderLeftWidth,
        paddingStart: getComputedStyle(chip).paddingInlineStart,
        glyphLeft: +(glyph.left - rect.left).toFixed(2),
        glyphWidth: +glyph.width.toFixed(2),
        glyphOffsetX: +(glyph.left + glyph.width / 2 - (rect.left + rect.height / 2)).toFixed(2),
        glyphOffsetY: +(glyph.top + glyph.height / 2 - (rect.top + rect.height / 2)).toFixed(2),
      }
    }),
  )
  await Bun.write(path.join(out, "geometry.json"), JSON.stringify(geometry, null, 2))

  // Zoomed crops of one row per variant (3 running), light then dark.
  const schemes = page.locator('[data-slot="capsule-scheme"]')
  for (const [index, scheme] of ["light", "dark"].entries()) {
    await schemes.nth(index).screenshot({ path: path.join(out, `grid-${scheme}.png`) })
  }
  await page.close()
}

// 2. Reduced motion: the orb's still pose.
{
  const context = await browser.newContext({
    viewport: { width: 1760, height: 1000 },
    reducedMotion: "reduce",
  })
  const page = await context.newPage()
  await open(page, "capsule-motion", 4)
  await page.screenshot({ path: path.join(out, "reduced.png") })
  await context.close()
}

// 3. Real-time clip of b vs c.
{
  const dir = path.join(out, "video")
  const context = await browser.newContext({
    viewport: { width: 1760, height: 1000 },
    recordVideo: { dir, size: { width: 1760, height: 1000 } },
  })
  const page = await context.newPage()
  await open(page, "capsule-motion", 4)
  await page.waitForTimeout(7000)
  await context.close()
  const file = readdirSync(dir).find((name) => name.endsWith(".webm"))!
  renameSync(path.join(dir, file), path.join(out, "motion.webm"))
}

await browser.close()
kill()
process.exit(0)

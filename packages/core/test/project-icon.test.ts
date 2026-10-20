import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { eq } from "drizzle-orm"
import { Effect, Stream } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Project } from "@opencode/core/project"
import { ProjectIcon } from "@opencode/core/project/icon"
import { ProjectSchema } from "@opencode/core/project/schema"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath, RelativePath } from "@opencode/core/schema"
import { FSUtil } from "@opencode/util/fs-util"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Project.node, Database.node, Bus.node, FSUtil.node])))
const SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='6'/></svg>"
const SVG_ALT = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16'/></svg>"

async function writeFile(root: string, relative: string, content: string | Uint8Array) {
  const target = path.join(root, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, content)
}

describe("ProjectIcon", () => {
  it.live("discovers priority icons, keeps https config URLs, and rejects traversal/symlinks/oversized files", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const fsUtil = yield* FSUtil.Service
      const root = AbsolutePath.make(path.join(tmp.path, "repo"))
      yield* Effect.promise(async () => {
        await writeFile(tmp.path, "outside.svg", SVG)
        await writeFile(root, "secret.txt", "secret")
        await writeFile(root, "Assets.xcassets/AppIcon.appiconset/icon_32.png", "small")
        await writeFile(root, "Assets.xcassets/AppIcon.appiconset/icon_256.png", "medium")
        await writeFile(root, "Assets.xcassets/AppIcon.appiconset/icon_1024.png", "huge")
        await writeFile(root, "public/favicon.svg", new Uint8Array(ProjectIcon.MAX_BYTES + 1))
        await writeFile(root, "assets/logo.svg", SVG)
      })

      expect(yield* ProjectIcon.discover(fsUtil, root)).toMatchObject({
        path: "Assets.xcassets/AppIcon.appiconset/icon_256.png",
      })

      yield* Effect.promise(async () => {
        await fs.rm(path.join(root, "Assets.xcassets"), { recursive: true })
        await fs.symlink(path.join(tmp.path, "outside.svg"), path.join(root, "public/icon.svg"))
        await fs.symlink(path.join(root, "secret.txt"), path.join(root, "public/favicon.png"))
        await writeFile(root, "opencode.jsonc", `{\n  // custom\n  "icon": "https://example.com/icon.svg"\n}`)
      })
      expect(yield* ProjectIcon.discover(fsUtil, root)).toEqual({ url: "https://example.com/icon.svg" })
      expect(yield* ProjectIcon.read(fsUtil, root, "public/icon.svg")).toBeUndefined()
      expect(yield* ProjectIcon.read(fsUtil, root, "public/favicon.png")).toBeUndefined()

      yield* Effect.promise(() => writeFile(root, "opencode.jsonc", JSON.stringify({ icon: "../outside.svg" })))
      expect(yield* ProjectIcon.discover(fsUtil, root)).toMatchObject({ path: "assets/logo.svg" })
    }),
  )

  it.live("persists versioned URLs, emits Updated for new non-VCS projects, and refreshes on sweep", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const root = AbsolutePath.make(path.join(tmp.path, "repo"))
      yield* Effect.promise(async () => {
        await writeFile(tmp.path, "outside.svg", SVG)
        await writeFile(root, "public/favicon.svg", SVG)
        await writeFile(root, "assets/logo.svg", SVG_ALT)
      })
      const project = yield* Project.Service
      const bus = yield* Bus.Service
      const db = (yield* Database.Service).db
      const events: Array<Project.Info> = []
      yield* bus.subscribe(ProjectSchema.Event.Updated).pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event.data))),
        Effect.forkScoped({ startImmediately: true }),
      )

      const resolved = yield* project.resolve(root)
      yield* Effect.yieldNow
      const currentUrl = () =>
        project.list().pipe(Effect.map((items) => items.find((item) => item.id === resolved.id)?.icon?.url ?? ""))
      const firstUrl = yield* currentUrl()
      const readText = () =>
        project.icon(resolved.id).pipe(Effect.map((img) => (img ? new TextDecoder().decode(img.bytes) : undefined)))

      expect(firstUrl).toMatch(new RegExp(`^/api/project/${resolved.id}/icon\\?v=[0-9a-f]{16}$`))
      expect(events.at(-1)?.icon?.url).toBe(firstUrl)
      expect(yield* readText()).toBe(SVG)
      expect((yield* project.icons(root)).map((item) => item.path)).toEqual([
        RelativePath.make("public/favicon.svg"),
        RelativePath.make("assets/logo.svg"),
      ])

      yield* Effect.promise(() => writeFile(root, "public/favicon.svg", SVG_ALT))
      yield* project.sweep()
      expect(yield* currentUrl()).not.toBe(firstUrl)

      yield* Effect.promise(async () => {
        await writeFile(root, "brand.svg", SVG)
        await writeFile(root, "opencode.json", JSON.stringify({ icon: "./brand.svg" }))
      })
      yield* project.sweep()
      expect(yield* currentUrl()).toBe(firstUrl)
      expect(yield* readText()).toBe(SVG)

      yield* Effect.promise(async () => {
        await fs.rm(path.join(root, "opencode.json"))
        await fs.rm(path.join(root, "brand.svg"))
        await fs.rm(path.join(root, "public/favicon.svg"))
      })
      expect(yield* readText()).toBeUndefined()
      yield* project.sweep()
      expect(yield* readText()).toBe(SVG_ALT)

      yield* db
        .update(ProjectTable)
        .set({ icon_url: "https://example.com/custom.svg" })
        .where(eq(ProjectTable.id, resolved.id))
        .run()
        .pipe(Effect.orDie)
      yield* project.sweep()
      expect(yield* currentUrl()).toBe("https://example.com/custom.svg")

      yield* db
        .update(ProjectTable)
        .set({ icon_url: `/api/project/${resolved.id}/icon?v=deadbeef&path=${encodeURIComponent("../outside.svg")}` })
        .where(eq(ProjectTable.id, resolved.id))
        .run()
        .pipe(Effect.orDie)
      expect(yield* readText()).toBeUndefined()
    }),
  )
})

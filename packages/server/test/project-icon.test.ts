import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { $ } from "bun"
import { Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

it.live(
  "serves discovered project icon bytes, ETag, CSP/nosniff headers, 304, and 404 when deleted",
  () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const directory = path.join(tmp.path, "checkout")
      const iconFile = path.join(directory, "public", "favicon.svg")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(iconFile), { recursive: true })
        await fs.writeFile(iconFile, "<svg />")
        await $`git init -q && git remote add origin https://github.com/acme/sketchbook.git`.cwd(directory).quiet()
      })
      const server = yield* startServer(path.join(tmp.path, "config"))
      const get = (pathname: string, headers: Record<string, string> = {}) =>
        Effect.promise(() => fetch(new URL(pathname, server.base), { headers: { ...server.headers, ...headers } }))

      const location = yield* get(`/api/location?location[directory]=${encodeURIComponent(directory)}`)
      const projectID = (yield* Effect.promise(() => location.json())).project.id
      const projects: Array<{ id: string; icon?: { url?: string } }> = yield* get("/api/project").pipe(
        Effect.flatMap((response) => Effect.promise(() => response.json())),
      )
      const url = projects.find((item) => item.id === projectID)?.icon?.url ?? ""
      const icon = yield* get(url)
      const etag = icon.headers.get("etag") ?? ""
      const revalidated = yield* get(url, { "if-none-match": etag })

      expect(url).toStartWith(`/api/project/${projectID}/icon?v=`)
      expect(icon.status).toBe(200)
      expect(icon.headers.get("content-type")).toBe("image/svg+xml")
      expect(icon.headers.get("cache-control")).toBe("private, max-age=31536000, immutable")
      expect(icon.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox")
      expect(icon.headers.get("x-content-type-options")).toBe("nosniff")
      expect(yield* Effect.promise(() => icon.text())).toBe("<svg />")
      expect(revalidated.status).toBe(304)

      yield* Effect.promise(() => fs.rm(iconFile))
      const missing = yield* get(url)
      expect(missing.status).toBe(404)
    }),
  15_000,
)

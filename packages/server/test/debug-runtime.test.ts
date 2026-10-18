import { expect } from "bun:test"
import { DebugRuntime } from "@opencode/protocol/groups/debug"
import { Effect, Schema } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const options = {
  app: { version: "test-version" },
  database: { path: ":memory:" },
  config: { project: false },
  models: { fetch: false },
  fs: { filewatcher: false },
} as const

const decode = Schema.decodeUnknownSync(DebugRuntime)

it.live("reports runtime memory and long-lived structure sizes", () =>
  Effect.gen(function* () {
    const config = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-debug-runtime-")))
    const handler = yield* ServerFetch.make({ ...options, config: { directory: config.path } })
    const read = (query = "") =>
      Effect.promise(() =>
        handler(new Request(`http://opencode.local/api/debug/runtime${query}`)).then(async (response) => {
          expect(response.status).toBe(200)
          return decode(await response.json())
        }),
      )

    const basic = yield* read()
    expect(basic.pid).toBe(process.pid)
    expect(basic.memory.rss).toBeGreaterThan(0)
    expect(basic.heap?.objectCount).toBeGreaterThan(0)
    expect(basic.heap?.types).toBeUndefined()
    expect(basic.locations).toBe(0)
    expect(basic.gauges["bus.live.backlog"]).toBe(0)
    expect(basic.gauges["bus.listeners"]).toBeGreaterThanOrEqual(1)
    expect(basic.gauges["job.total"]).toBe(0)

    // Booting a Location registers its plugin registry and tracks its service graph.
    const location = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/location", {
          headers: { "x-opencode-directory": encodeURIComponent(config.path) },
        }),
      ),
    )
    expect(location.status).toBe(200)
    const detailed = yield* read("?types=true&gc=true")
    expect(detailed.locations).toBe(1)
    expect(detailed.reachable["location.graph"]).toBeGreaterThanOrEqual(1)
    expect(detailed.reachable["plugin.registry"]).toBeGreaterThanOrEqual(1)
    // Activation may still be running; the registry's gauge exists either way.
    expect(detailed.gauges["plugin.active"]).toBeGreaterThanOrEqual(0)
    expect(Object.keys(detailed.heap?.types ?? {}).length).toBeGreaterThan(0)
  }),
)

it.live("refuses heap snapshots unless enabled", () =>
  Effect.gen(function* () {
    const config = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-debug-heap-")))
    const handler = yield* ServerFetch.make({ ...options, config: { directory: config.path } })
    const response = yield* Effect.promise(() =>
      handler(new Request("http://opencode.local/api/debug/heap-snapshot", { method: "POST" })),
    )
    expect(response.status).toBe(503)
  }),
)

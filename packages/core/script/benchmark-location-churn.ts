// Boot a Location service graph, wait for plugin activation, then invalidate it (what
// LocationActivity does after 60 idle minutes) and repeat. Prints heap retained per cycle and
// how many evicted graphs and plugin registries the GC still reaches.
// Fully isolated: temp global dirs, in-memory DB, no watchers, no network.
//
//   bun run script/benchmark-location-churn.ts [--cycles 30] [--distinct] [--plugins a,b,c] [--verbose]
//
// --distinct   use a new directory every cycle (new locations) instead of re-booting one
// --plugins    comma-separated absolute local plugin directories written into the temp global config
import fs from "fs/promises"
import os from "os"
import path from "path"
import { heapStats } from "bun:jsc"
import { Effect, Logger } from "effect"
import { FetchHttpClient } from "effect/http"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { Bus } from "../src/bus"
import { Database } from "../src/database/database"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-service-map"
import { ModelsDev } from "../src/models-dev"
import { Plugin } from "../src/plugin"
import { AbsolutePath } from "../src/schema"
import { RuntimeStats } from "../src/runtime-stats"
import { Watcher } from "../src/filesystem/watcher"

const args = process.argv.slice(2)
const value = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}
const cycles = Number(value("cycles") ?? 30)
const distinct = args.includes("--distinct")
const plugins = (value("plugins") ?? "").split(",").filter(Boolean)

const sample = () => {
  Bun.gc(true)
  Bun.gc(true)
  const usage = process.memoryUsage()
  const stats = heapStats()
  return { heapUsed: usage.heapUsed, rss: usage.rss, objects: stats.objectCount, protos: stats.protectedObjectCount }
}
const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(2)

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-leak-churn-")))
await fs.mkdir(path.join(root, "config"), { recursive: true })
await fs.writeFile(
  path.join(root, "config", "opencode.json"),
  JSON.stringify({
    plugins: plugins.map((p) => ({
      package: p,
      options: { journal: "", stateDir: path.join(root, "state", path.basename(path.dirname(p))) },
    })),
  }),
)
const globalLayer = Global.layerWith({
  home: path.join(root, "home"),
  data: path.join(root, "data"),
  cache: path.join(root, "cache"),
  config: path.join(root, "config"),
  state: path.join(root, "state"),
  tmp: path.join(root, "tmp"),
  bin: path.join(root, "cache", "bin"),
  log: path.join(root, "data", "log"),
  repos: path.join(root, "data", "repos"),
})
const replacements = [
  Global.node.replace(globalLayer),
  ModelsDev.node.replace(ModelsDev.configured({ fetch: false })),
  Watcher.node.replace(Watcher.configured({ enabled: false })),
]

const program = Effect.gen(function* () {
  const locations = yield* LocationServiceMap.Service
  const before = sample()
  const rows: {
    cycle: number
    heapMb: string
    deltaMb: string
    objects: number
    reachable: Record<string, number>
    gauges: Record<string, number>
  }[] = []
  let previous = before
  for (let cycle = 0; cycle < cycles; cycle++) {
    const directory = path.join(root, "projects", distinct ? `location-${cycle}` : "location")
    yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
    const ref = Location.Ref.make({ directory: AbsolutePath.make(directory) })
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* locations.contextEffect(ref)
        const registry = yield* Plugin.Service.pipe(Effect.provideContext(context))
        yield* registry.awaitActivation
        if (cycle === 0 && args.includes("--verbose")) {
          const listed = yield* registry.list()
          console.error(JSON.stringify(listed, (_k, v) => (typeof v === "function" ? undefined : v)).slice(0, 4000))
        }
      }),
    )
    yield* locations.invalidate(ref)
    yield* Effect.sleep("20 millis")
    const current = sample()
    rows.push({
      cycle,
      heapMb: mib(current.heapUsed),
      deltaMb: mib(current.heapUsed - previous.heapUsed),
      objects: current.objects,
      // FinalizationRegistry callbacks run after a GC turn; `sample()` already forced one.
      reachable: RuntimeStats.reachable(),
      gauges: RuntimeStats.read(),
    })
    previous = current
  }
  return { before, after: previous, rows }
}).pipe(
  Effect.provide(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, LocationServiceMap.node]), replacements)),
  Effect.provide(Logger.layer([])),
  Effect.provideService(
    FetchHttpClient.Fetch,
    Object.assign(() => Promise.reject(new Error("Network disabled in leak repro")), { preconnect: () => {} }),
  ),
)

const result = await Effect.runPromise(program)
await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
const warm = result.rows.slice(Math.min(5, result.rows.length - 1))
const perCycle =
  warm.length > 1
    ? (Number(warm.at(-1)!.heapMb) - Number(warm[0].heapMb)) / (warm.length - 1)
    : Number.NaN
if (args.includes("--json")) console.log(JSON.stringify({ cycles, distinct, plugins, rows: result.rows }))
const last = result.rows.at(-1)
console.log(
  `boot+evict ${cycles}x (${distinct ? "distinct dirs" : "same dir"}, plugins: ${plugins.length}): heap ${mib(result.before.heapUsed)} → ${mib(result.after.heapUsed)} MiB, objects ${result.before.objects} → ${result.after.objects}; steady-state ${perCycle.toFixed(2)} MiB/cycle after warmup`,
)
console.log(`still reachable after the last eviction: ${JSON.stringify(last?.reachable)}`)
console.log(`gauges: ${JSON.stringify(last?.gauges)}`)

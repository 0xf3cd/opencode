// Server-wired Location churn: boot a Location over HTTP, evict it with DELETE /api/debug/location,
// repeat, and read /api/debug/runtime (after a full GC) every few cycles. Uses the real server
// layer graph, an in-memory database and temp directories; no network, no live server.
//
//   bun run script/benchmark-location-churn.ts [--cycles 40] [--distinct] [--plugins a,b,c]
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { ServerFetch } from "../src/fetch"

const args = process.argv.slice(2)
const value = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}
const cycles = Number(value("cycles") ?? 40)
const distinct = args.includes("--distinct")
const plugins = (value("plugins") ?? "").split(",").filter(Boolean)

// Global paths come from XDG_* and OPENCODE_CONFIG_DIR; refuse to run against a real profile.
const configDir = process.env.OPENCODE_CONFIG_DIR
const tmp = await fs.realpath(os.tmpdir())
const underTmp = async (dir?: string) => !!dir && (await fs.realpath(dir).catch(() => dir)).startsWith(tmp)
if (!configDir || !(await underTmp(configDir)) || !(await underTmp(process.env.XDG_DATA_HOME))) {
  console.error("Set OPENCODE_CONFIG_DIR and XDG_DATA_HOME/XDG_STATE_HOME/XDG_CACHE_HOME to directories under $TMPDIR.")
  process.exit(1)
}
const root = await fs.realpath(await fs.mkdtemp(path.join(tmp, "opencode-server-churn-")))
const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)

await fs.writeFile(
  path.join(configDir, "opencode.json"),
  JSON.stringify({
    plugins: plugins.map((p) => ({ package: p, options: { journal: "", stateDir: path.join(root, "state") } })),
  }),
)

const program = Effect.gen(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "churn" },
    database: { path: ":memory:" },
    config: { directory: configDir, project: false },
    models: { fetch: false },
    fs: { filewatcher: false },
  })
  const call = (url: string, init?: RequestInit) =>
    Effect.promise(() => handler(new Request(`http://opencode.local${url}`, init)))
  const runtime = () =>
    call("/api/debug/runtime?gc=true").pipe(Effect.flatMap((r) => Effect.promise(() => r.json() as Promise<any>)))

  const rows: string[] = []
  const first = yield* runtime()
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const directory = path.join(root, "projects", distinct ? `p${cycle}` : "p")
    yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
    const headers = { "x-opencode-directory": encodeURIComponent(directory) }
    const booted = yield* call("/api/location", { headers })
    if (booted.status !== 200) throw new Error(`boot failed: ${booted.status} ${yield* Effect.promise(() => booted.text())}`)
    // Plugins finish activating asynchronously; listing them waits on activation.
    const listed = yield* call("/api/plugin", { headers })
    if (cycle === 1 && args.includes("--verbose")) {
      const body = (yield* Effect.promise(() => listed.json())) as { data?: { id: string; state: unknown }[] }
      console.error(JSON.stringify(body.data?.filter((p) => !p.id.startsWith("opencode.")) ?? body))
    }
    if (cycle === 1) {
      const held = yield* runtime()
      rows.push(
        `held  one booted Location: liveSubs ${held.gauges["bus.live.subscribers"]}  listeners ${held.gauges["bus.listeners"]}  heapUsed ${mib(held.memory.heapUsed)} MiB`,
      )
    }
    yield* call(`/api/debug/location?location[directory]=${encodeURIComponent(directory)}`, { method: "DELETE" })
    if (cycle % 10 === 0 || cycle === cycles) {
      const r = yield* runtime()
      rows.push(
        `${String(cycle).padStart(4)}  heapUsed ${mib(r.memory.heapUsed).padStart(7)} MiB  objects ${String(r.heap?.objectCount).padStart(8)}  locations ${r.locations}  reachable ${JSON.stringify(r.reachable)}  projectors ${r.gauges["bus.projectors"]}  listeners ${r.gauges["bus.listeners"]}  liveSubs ${r.gauges["bus.live.subscribers"]}  typed ${r.gauges["bus.typed.pubsubs"]}`,
      )
    }
  }
  return { first, rows }
}).pipe(Effect.scoped)

const result = await Effect.runPromise(program)
await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
console.log(
  `start: heapUsed ${mib(result.first.memory.heapUsed)} MiB, objects ${result.first.heap?.objectCount}, projectors ${result.first.gauges["bus.projectors"]}, listeners ${result.first.gauges["bus.listeners"]}`,
)
for (const row of result.rows) console.log(row)

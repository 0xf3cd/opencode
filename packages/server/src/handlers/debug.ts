import { LocationServiceMap } from "@opencode/core/location-service-map"
import { RuntimeStats } from "@opencode/core/runtime-stats"
import { ServiceUnavailableError } from "@opencode/protocol/errors"
import { Global } from "@opencode/util/global"
import { Effect, Option, RcMap } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import os from "node:os"
import path from "node:path"
import { Api } from "../api"
import { requestRef } from "../location"

export const DebugHandler = HttpApiBuilder.group(Api, "server.debug", (handlers) =>
  handlers
    .handle(
      "debug.location",
      Effect.fn(function* () {
        const locations = Option.getOrThrow(yield* Effect.serviceOption(LocationServiceMap.Service))
        return Array.from(yield* RcMap.keys(locations.rcMap))
      }),
    )
    .handle(
      "debug.location.evict",
      Effect.fn(function* (ctx) {
        const locations = Option.getOrThrow(yield* Effect.serviceOption(LocationServiceMap.Service))
        // Resolve through requestRef so the key matches the shape the location
        // middleware cached the services under.
        yield* locations.invalidate(requestRef(ctx.request))
      }),
    )
    .handle(
      "debug.runtime",
      Effect.fn(function* (ctx) {
        const locations = yield* Effect.serviceOption(LocationServiceMap.Service)
        if (ctx.query.gc && typeof Bun !== "undefined") yield* Effect.sync(() => Bun.gc(true))
        const memory = process.memoryUsage()
        return {
          pid: process.pid,
          uptimeSeconds: Math.round(process.uptime()),
          memory: {
            rss: memory.rss,
            heapTotal: memory.heapTotal,
            heapUsed: memory.heapUsed,
            external: memory.external,
            arrayBuffers: memory.arrayBuffers,
          },
          heap: yield* Effect.promise(() => RuntimeStats.heap({ types: ctx.query.types })),
          locations: Option.isSome(locations) ? Array.from(yield* RcMap.keys(locations.value.rcMap)).length : 0,
          gauges: RuntimeStats.read(),
          reachable: RuntimeStats.reachable(),
        }
      }),
    )
    .handle(
      "debug.heapSnapshot",
      Effect.fn(function* () {
        if (process.env.OPENCODE_DEBUG_HEAP_SNAPSHOT !== "1")
          return yield* new ServiceUnavailableError({
            message: "Heap snapshots are disabled. Start the server with OPENCODE_DEBUG_HEAP_SNAPSHOT=1.",
            service: "debug",
          })
        const global = yield* Effect.serviceOption(Global.Service)
        const directory = Option.match(global, { onNone: () => os.tmpdir(), onSome: (global) => global.log })
        const file = path.join(
          directory,
          `heap-${process.pid}-${new Date().toISOString().replace(/[:.]/g, "")}.heapsnapshot`,
        )
        yield* Effect.logInfo("writing heap snapshot", { path: file })
        const { writeHeapSnapshot } = yield* Effect.promise(() => import("node:v8"))
        yield* Effect.try({
          try: () => writeHeapSnapshot(file),
          catch: (cause) =>
            new ServiceUnavailableError({ message: `Failed to write heap snapshot: ${String(cause)}`, service: "debug" }),
        })
        yield* Effect.logInfo("heap snapshot written", { path: file })
        return { path: file }
      }),
    ),
)

import { Location } from "@opencode/schema/location"
import { Schema, SchemaGetter } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { ServiceUnavailableError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const BooleanFromString = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value): "true" | "false" => (value ? "true" : "false")),
  }),
)

const Counts = Schema.Record(Schema.String, Schema.Number)

export const DebugRuntime = Schema.Struct({
  pid: Schema.Number,
  uptimeSeconds: Schema.Number,
  memory: Schema.Struct({
    rss: Schema.Number,
    heapTotal: Schema.Number,
    heapUsed: Schema.Number,
    external: Schema.Number,
    arrayBuffers: Schema.Number,
  }),
  heap: Schema.optional(
    Schema.Struct({
      heapSize: Schema.Number,
      heapCapacity: Schema.Number,
      extraMemorySize: Schema.Number,
      objectCount: Schema.Number,
      protectedObjectCount: Schema.Number,
      globalObjectCount: Schema.Number,
      protectedGlobalObjectCount: Schema.Number,
      types: Schema.optional(Counts),
      protectedTypes: Schema.optional(Counts),
    }),
  ),
  locations: Schema.Number,
  gauges: Counts,
  reachable: Counts,
}).annotate({ identifier: "DebugRuntime" })
export type DebugRuntime = typeof DebugRuntime.Type

export const DebugGroup = HttpApiGroup.make("server.debug")
  .add(
    HttpApiEndpoint.get("debug.location", "/api/debug/location", {
      success: Schema.Array(Location.PublicRef),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "debug.location.list",
        summary: "List loaded locations",
        description: "List locations currently loaded by the server.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("debug.location.evict", "/api/debug/location", {
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "debug.location.evict",
          summary: "Evict a loaded location",
          description: "Dispose the requested location's cached services so its next use boots them fresh.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("debug.runtime", "/api/debug/runtime", {
      query: Schema.Struct({
        types: BooleanFromString.pipe(Schema.optional),
        gc: BooleanFromString.pipe(Schema.optional),
      }),
      success: DebugRuntime,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "debug.runtime",
        summary: "Read runtime memory statistics",
        description:
          "Process memory, JSC heap totals and the sizes of long-lived server structures (event bus buffers and subscribers, loaded locations, plugin registries, jobs, event feed queues). `types=true` adds the largest object counts by constructor and walks the whole heap; `gc=true` runs a full collection first so `reachable` counts are current. Both block the server for the duration on a large heap.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("debug.heapSnapshot", "/api/debug/heap-snapshot", {
      success: Schema.Struct({ path: Schema.String }),
      error: ServiceUnavailableError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "debug.heapSnapshot",
        summary: "Write a heap snapshot",
        description:
          "Write a heap snapshot to the server log directory and return its path. Disabled unless the server was started with OPENCODE_DEBUG_HEAP_SNAPSHOT=1, because it pauses the server and needs about as much free memory as the heap itself.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "debug" }))

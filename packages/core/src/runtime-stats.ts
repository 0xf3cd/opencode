export * as RuntimeStats from "./runtime-stats.js"

/**
 * Pull-based process diagnostics for long-running servers.
 *
 * Long-lived structures register a cheap gauge (a closure reading a size they
 * already hold). Nothing is sampled until a client asks, so the cost when idle is
 * one closure per structure. Gauges must be O(1) or O(entries) reads, never IO.
 */

export type Gauge = () => number | Readonly<Record<string, number>>

const gauges = new Map<string, Set<Gauge>>()

/** Register a gauge; returns its unregister function. Same-named gauges are summed (one per Location, say). */
export function register(name: string, gauge: Gauge): () => void {
  const set = gauges.get(name) ?? new Set()
  set.add(gauge)
  gauges.set(name, set)
  return () => {
    set.delete(gauge)
    if (set.size === 0 && gauges.get(name) === set) gauges.delete(name)
  }
}

/** Current value of every gauge. Gauges with several instances report the sum and the instance count. */
export function read(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, set] of [...gauges].sort(([a], [b]) => a.localeCompare(b))) {
    if (set.size > 1) out[`${name}.instances`] = set.size
    for (const gauge of set) {
      const value = safe(gauge)
      if (typeof value === "number") {
        out[name] = (out[name] ?? 0) + value
        continue
      }
      for (const [key, n] of Object.entries(value)) out[`${name}.${key}`] = (out[`${name}.${key}`] ?? 0) + n
    }
  }
  return out
}

const alive = new Map<string, number>()
const collected = new FinalizationRegistry<string>((name) => alive.set(name, (alive.get(name) ?? 1) - 1))

/**
 * Count instances still reachable from the GC's point of view. Use it for objects
 * that should die with a scope (a Location graph, a plugin registry): a count that
 * keeps rising after their scopes close is a retention leak, not a lifecycle bug.
 */
export function track(name: string, target: object) {
  alive.set(name, (alive.get(name) ?? 0) + 1)
  collected.register(target, name)
}

/** Live counts for tracked instances. Only meaningful after a GC; FinalizationRegistry callbacks are lazy. */
export function reachable(): Record<string, number> {
  return Object.fromEntries([...alive].sort(([a], [b]) => a.localeCompare(b)))
}

function safe(gauge: Gauge) {
  try {
    return gauge()
  } catch {
    // JSON has no NaN; -1 marks a gauge that threw.
    return -1
  }
}

export type Heap = {
  readonly heapSize: number
  readonly heapCapacity: number
  readonly extraMemorySize: number
  readonly objectCount: number
  readonly protectedObjectCount: number
  readonly globalObjectCount: number
  readonly protectedGlobalObjectCount: number
  readonly types?: Readonly<Record<string, number>>
  readonly protectedTypes?: Readonly<Record<string, number>>
}

/**
 * JSC heap statistics. `types` walks every cell (hundreds of ms on a multi-GB
 * heap), so callers opt in and get only the largest `limit` constructors.
 */
export async function heap(options: { readonly types?: boolean; readonly limit?: number } = {}): Promise<Heap | undefined> {
  if (typeof Bun === "undefined") return undefined
  const { heapStats } = await import("bun:jsc")
  const stats = heapStats()
  const top = (counts: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, options.limit ?? 40),
    )
  return {
    heapSize: stats.heapSize,
    heapCapacity: stats.heapCapacity,
    extraMemorySize: stats.extraMemorySize,
    objectCount: stats.objectCount,
    protectedObjectCount: stats.protectedObjectCount,
    globalObjectCount: stats.globalObjectCount,
    protectedGlobalObjectCount: stats.protectedGlobalObjectCount,
    ...(options.types
      ? { types: top(stats.objectTypeCounts), protectedTypes: top(stats.protectedObjectTypeCounts) }
      : {}),
  }
}

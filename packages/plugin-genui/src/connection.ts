export * as GenUIConnection from "./connection.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { Session } from "@opencode/schema/session"
import { Effect, Schedule, Semaphore, Stream } from "effect"
import { GenUI } from "./rpc.js"

export type Connection = Effect.Success<ReturnType<typeof make>>

/**
 * Tracks which desktop or web app windows show each session. A window holds a lease it renews every
 * `RENEW_MS`, so a closed or crashed window drops out after `LEASE_MS` without a long-lived request.
 */
export const make = Effect.fn("GenUIConnection.make")(function* (
  ctx: Pick<Context, "agent" | "rpc" | "session" | "location" | "event">,
) {
  // Session → connection → lease expiry.
  const viewers = new Map<Session.ID, Map<string, number>>()
  const lock = Semaphore.makeUnsafe(1)
  // Appended after config, so every agent hides the tools until a window shows the session.
  yield* ctx.agent.transform((editor) =>
    editor.list().forEach((agent) => agent.permissions.push({ action: "genui", resource: "*", effect: "deny" })),
  )
  const permit = (sessionID: Session.ID, allow: boolean) =>
    ctx.session.get({ sessionID }).pipe(
      Effect.flatMap((session) => {
        const permissions = session.permissions ?? []
        const index = permissions.findIndex(
          (rule) => rule.action === "genui" && rule.resource === "*" && rule.effect === "allow",
        )
        if (allow === (index !== -1)) return Effect.void
        return ctx.session.update({
          sessionID,
          permissions: allow
            ? [...permissions, { action: "genui", resource: "*", effect: "allow" }]
            : permissions.toSpliced(index, 1),
        })
      }),
      Effect.ignore,
    )
  const drop = (sessionID: Session.ID, connectionID?: string) =>
    Effect.gen(function* () {
      const leases = viewers.get(sessionID)
      if (!leases) return
      if (connectionID) leases.delete(connectionID)
      if (connectionID && leases.size > 0) return
      viewers.delete(sessionID)
      yield* permit(sessionID, false)
    })

  yield* Effect.addFinalizer(() =>
    lock.withPermit(Effect.forEach([...viewers.keys()], (sessionID) => drop(sessionID), { discard: true })),
  )
  yield* Effect.suspend(() => {
    const now = Date.now()
    const expired = [...viewers].flatMap(([sessionID, leases]) =>
      [...leases].filter(([, expires]) => expires <= now).map(([connectionID]) => ({ sessionID, connectionID })),
    )
    return Effect.forEach(expired, (lease) => drop(lease.sessionID, lease.connectionID), { discard: true })
  }).pipe(lock.withPermit, Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkScoped)
  yield* ctx.event.subscribe().pipe(
    Stream.filter((event) => event.type === "session.deleted" || event.type === "session.moved"),
    Stream.runForEach((event) => lock.withPermit(drop(event.data.sessionID))),
    Effect.forkScoped({ startImmediately: true }),
  )

  yield* ctx.rpc
    .register(GenUI.Definition, {
      attach: (input, call) =>
        Effect.gen(function* () {
          const session = yield* ctx.session
            .get({ sessionID: input.sessionID })
            .pipe(Effect.mapError(() => call.error("unavailable", "Session not found.", {})))
          if (session.location.directory !== ctx.location.directory)
            return yield* Effect.fail(call.error("unavailable", "Session belongs to another location.", {}))
          const leases = viewers.get(input.sessionID) ?? new Map<string, number>()
          const first = leases.size === 0
          leases.set(input.connectionID, Date.now() + GenUI.LEASE_MS)
          viewers.set(input.sessionID, leases)
          if (first) yield* permit(input.sessionID, true)
          return { renewMs: GenUI.RENEW_MS }
        }).pipe(lock.withPermit),
      detach: (input) => drop(input.sessionID, input.connectionID).pipe(lock.withPermit),
    })
    .pipe(Effect.orDie)

  return {
    /** Whether an app window shows the session, so the user can see what the agent renders. */
    visible: (sessionID: Session.ID) => (viewers.get(sessionID)?.size ?? 0) > 0,
  }
})

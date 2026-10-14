export * as CredentialLock from "./lock.js"

import { Context, Effect, Fiber, Layer } from "effect"
import { Credential } from "@opencode/schema/credential"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

export interface Interface {
  /** Concurrent callers for the same credential share the running operation's result, including failures. */
  readonly withLock: (
    id: Credential.ID,
    operation: Effect.Effect<Credential.OAuth | undefined, unknown>,
  ) => Effect.Effect<Credential.OAuth | undefined, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CredentialLock") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const pending = new Map<Credential.ID, Fiber.Fiber<Credential.OAuth | undefined, unknown>>()

    return Service.of({
      withLock: Effect.fn("CredentialLock.withLock")((id, operation) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const current = pending.get(id)
            if (current) return yield* restore(Fiber.join(current))
            // The global scope owns the operation, not the first Session or Location waiting for it.
            const fiber = yield* operation.pipe(
              Effect.ensuring(Effect.sync(() => pending.delete(id))),
              Effect.forkIn(scope),
            )
            pending.set(id, fiber)
            return yield* restore(Fiber.join(fiber))
          }),
        ),
      ),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

export * as ConnectTicket from "./connect-ticket.js"

import { Schema } from "effect"
import { PositiveInt } from "./schema.js"

/** A short-lived single-use ticket that authorizes one WebSocket upgrade from a browser. */
export const Token = Schema.Struct({
  ticket: Schema.String,
  expires_in: PositiveInt,
}).annotate({ identifier: "ConnectTicket.Token" })
export interface Token extends Schema.Schema.Type<typeof Token> {}

export * as GenUI from "./rpc.js"

import { Schema } from "effect"
import { Rpc } from "@opencode/schema/rpc"
import { Session } from "@opencode/schema/session"

export const MAX_CODE = 100_000
/** How long an attachment lasts without a renewal. */
export const LEASE_MS = 45_000
/** How often an attached app renews its lease. */
export const RENEW_MS = 15_000
/** The model-facing name of the render tool, and the tool name its calls carry in the timeline. */
export const RENDER_TOOL = "genui_render"

export const SurfaceID = Schema.String.check(Schema.isPattern(/^ui_[A-Za-z0-9_-]{1,96}$/u))
  .pipe(Schema.brand("GenUI.SurfaceID"))
  .annotate({ identifier: "GenUI.SurfaceID" })
export type SurfaceID = typeof SurfaceID.Type

/**
 * The surface a render call creates when it names none: derived from the call ID, so a client can identify a
 * surface from the call while it still streams.
 */
export const surfaceFor = (callID: string) => SurfaceID.make(`ui_${callID.replace(/[^A-Za-z0-9_-]/gu, "").slice(-96)}`)

const attachment = { sessionID: Session.ID, connectionID: Schema.String }
const errors = { unavailable: Schema.toStandardSchemaV1(Schema.Struct({})) }

// Standard Schema, so the app window's promise client, which only takes portable definitions, can call it too.
// Surfaces themselves reach clients through the session's own tool calls; this only tracks who can see them.
export const Definition = Rpc.define({
  id: "experimental.genui",
  methods: {
    attach: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ ...attachment, version: Schema.Literal(2) })),
      output: Schema.toStandardSchemaV1(Schema.Struct({ renewMs: Schema.Int })),
      errors,
    },
    detach: {
      input: Schema.toStandardSchemaV1(Schema.Struct(attachment)),
      output: Schema.toStandardSchemaV1(Schema.Void),
      errors,
    },
  },
  events: {},
})

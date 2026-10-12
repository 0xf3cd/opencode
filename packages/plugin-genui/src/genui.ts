export * as GenUI from "./genui.js"

import { Schema } from "effect"

export const MAX_CODE = 100_000
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

/** A render call's arguments as clients see them: any field may still be missing or cut off while it streams. */
export const RenderInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  surfaceID: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
})
export type RenderInput = typeof RenderInput.Type

/** Strips the Markdown fence models sometimes wrap a program in, including one that is still open. */
export const unfence = (code: string) =>
  code
    .trim()
    .replace(/^```[\w-]*\n?/u, "")
    .replace(/\n?```$/u, "")

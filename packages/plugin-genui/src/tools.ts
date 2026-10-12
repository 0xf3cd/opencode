export * as GenUITools from "./tools.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { optional, AbsolutePath } from "@opencode/schema/schema"
import { Skill } from "@opencode/schema/skill"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { GenUICatalog } from "./catalog.js"
import { GenUI } from "./genui.js"
import { GenUIGuide } from "./guide.js"
import type { GenUILang } from "./lang.js"

export const register = Effect.fn("GenUITools.register")(function* (ctx: Pick<Context, "tool" | "skill">) {
  yield* ctx.skill.transform((editor) =>
    editor.add(
      Skill.Info.make({
        id: Skill.ID.make("genui"),
        name: Skill.Name.make("GenUI"),
        description: `Syntax, components and examples for ${GenUI.RENDER_TOOL}. Load it before your first ${GenUI.RENDER_TOOL} call.`,
        path: AbsolutePath.make("/builtin/genui.md"),
        content: GenUIGuide.text,
      }),
    ),
  )
  yield* ctx.tool
    .transform((editor) =>
      editor.add({
        name: "render",
        description: `Show the user interactive UI in the OpenCode app: dashboards, charts, plans, comparisons, pickers, forms and small stateful tools. It renders natively while you write it. Load the genui skill for the syntax first. Replies from buttons and forms arrive as the user's next message. Pass surfaceID from an earlier result to replace that surface. Every call is checked and its problems come back in the result.`,
        // Property order is the order models write arguments in: the title and target first, so a client can place
        // the surface before its program streams in.
        input: Schema.Struct({
          title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).annotate({
            description: "Short title, e.g. 'Test results'.",
          }),
          surfaceID: optional(GenUI.SurfaceID).annotate({
            description: "surfaceID of an earlier render to replace in place.",
          }),
          code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(GenUI.MAX_CODE)).annotate({
            description: "GenUI program. Starts with root = Surface(...). No Markdown fences.",
          }),
        }),
        output: Schema.Struct({ surfaceID: GenUI.SurfaceID, issues: Schema.Array(Schema.String) }),
        options: { namespace: "genui", permission: "genui", codemode: false },
        execute: (input, tool) =>
          Effect.gen(function* () {
            const checked = GenUICatalog.check(GenUI.unfence(input.code))
            const issues = checked.issues.map(describe)
            if (!checked.root)
              return yield* new Tool.Error({
                message: ["Nothing rendered. Fix these problems and call genui_render again:", ...issues].join("\n- "),
              })
            const surfaceID = input.surfaceID ?? GenUI.surfaceFor(tool.id)
            return {
              output: { surfaceID, issues },
              content:
                issues.length === 0
                  ? `Rendered surface ${surfaceID}.`
                  : [
                      `Rendered surface ${surfaceID} with ${issues.length} ${issues.length === 1 ? "problem" : "problems"}; the blocks they affect are not shown. Call ${GenUI.RENDER_TOOL} again with surfaceID ${surfaceID} and the fixed program:`,
                      ...issues,
                    ].join("\n- "),
            }
          }),
      }),
    )
    .pipe(Effect.orDie)
})

function describe(issue: GenUILang.Issue) {
  if (!issue.statement) return issue.message
  return `${issue.statement} (line ${issue.line ?? "?"}): ${issue.message}`
}

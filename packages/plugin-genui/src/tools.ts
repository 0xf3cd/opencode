export * as GenUITools from "./tools.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { optional } from "@opencode/schema/schema"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import type { GenUIConnection } from "./connection.js"
import { GenUILibrary } from "./library.js"
import { GenUI } from "./rpc.js"

export const register = Effect.fn("GenUITools.register")(function* (
  ctx: Pick<Context, "tool">,
  connection: GenUIConnection.Connection,
) {
  yield* ctx.tool
    .transform((editor) => {
      editor.add({
        name: "guide",
        description:
          "Returns the OpenUI Lang reference for genui_render: syntax, every component signature, rules and examples. Read it once per session before your first genui_render.",
        input: Schema.Struct({}),
        options: { namespace: "genui", permission: "genui", codemode: false },
        execute: () => Effect.succeed({ content: guide }),
      })
      editor.add({
        name: "render",
        description:
          "Show the user interactive UI written in OpenUI Lang: dashboards, plans, comparisons, pickers and forms. It renders natively in the OpenCode app as you write it, line by line. Button clicks and form submissions arrive as the user's next message. Pass surfaceID from an earlier result to replace that surface instead of adding a new one.",
        // Property order is the order models write arguments in: the title and target first, so a client can place
        // the surface before its program streams in.
        input: Schema.Struct({
          title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).annotate({
            description: "Short title, e.g. 'Test results'.",
          }),
          surfaceID: optional(GenUI.SurfaceID).annotate({
            description: "surfaceID of an earlier genui_render result to update in place.",
          }),
          code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(GenUI.MAX_CODE)).annotate({
            description: "OpenUI Lang program. Start with root = Surface(...). No Markdown fences.",
          }),
        }),
        output: Schema.Struct({ surfaceID: GenUI.SurfaceID, issues: Schema.Array(Schema.String) }),
        options: { namespace: "genui", permission: "genui", codemode: false, streamInput: true },
        execute: (input, tool) =>
          Effect.gen(function* () {
            const parsed = GenUILibrary.parse(GenUILibrary.unfence(input.code))
            const issues = [
              ...parsed.meta.errors.map((error) =>
                [error.statementId, error.message].filter((part) => part !== undefined).join(": "),
              ),
              ...parsed.meta.unresolved.map((name) => `${name}: referenced but never defined; it renders as nothing.`),
              ...parsed.meta.orphaned.map(
                (name) => `${name}: defined but not reachable from root; it does not render.`,
              ),
            ]
            if (!parsed.root)
              return yield* new Tool.Error({
                message: ["Nothing to render: the program has no valid root = Surface(...).", ...issues].join("\n- "),
              })
            if (!connection.visible(tool.sessionID))
              return yield* new Tool.Error({
                message:
                  "[genui.disconnected] No OpenCode app window shows this session, so nobody saw this surface. Ask the user to open the session in the desktop or web app. Repeating the call will not help.",
              })
            return { output: { surfaceID: input.surfaceID ?? GenUI.surfaceFor(tool.id), issues } }
          }),
      })
    })
    .pipe(Effect.orDie)
})
const guide = GenUILibrary.library.prompt({
  preamble:
    "You write OpenUI Lang for the `code` argument of genui_render. The code is openui-lang only: no Markdown fences, no prose. The surface renders natively in the user's OpenCode app while you write it, so define root first and then each block in reading order. The app owns every color, size and spacing; you choose structure and content only. Buttons, clickable Rows and Form submissions come back to you as the user's next message.",
  toolCalls: false,
  bindings: false,
  additionalRules: [
    "Show real data from the workspace, tool results and the conversation. Label illustrative or estimated values as such.",
    "Prefer a few dense blocks over many sparse ones. Title groups with Section; do not repeat the tab title inside the surface.",
    "Use tone for meaning only: success, warning and danger for outcomes, neutral or info otherwise.",
    "Use Notice only for a fact the user must not miss. Use Status for states and Text for everything else.",
    "Write every Button and Row message as a complete instruction that reads well on its own in the chat.",
    "To change a surface, call genui_render again with its surfaceID and the complete new program.",
  ],
  examples: GenUILibrary.examples.map((example) => `${example.title}:\n${example.code}`),
})

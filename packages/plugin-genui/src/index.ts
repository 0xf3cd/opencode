import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { GenUISession } from "./session.js"
import { GenUITools } from "./tools.js"

export default Plugin.define({
  id: "opencode.genui",
  effect: (ctx) =>
    Effect.gen(function* () {
      yield* GenUITools.register(ctx)
      yield* GenUISession.register(ctx)
    }),
})

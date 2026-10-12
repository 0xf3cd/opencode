import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { GenUIConnection } from "./connection.js"
import { GenUITools } from "./tools.js"

export default Plugin.define({
  id: "opencode.genui",
  effect: (ctx) =>
    Effect.gen(function* () {
      const connection = yield* GenUIConnection.make(ctx)
      yield* GenUITools.register(ctx, connection)
    }),
})

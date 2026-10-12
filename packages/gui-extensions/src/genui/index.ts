import { Schema } from "effect"
import { Browser } from "../browser/contract"
import { Extension, Store } from "../sdk"
import en from "./i18n/en"

const Placement = Schema.Struct({ placement: Schema.Literals(["timeline", "panel"]) })

export default Extension.define({
  id: "genui",
  // Without the browser pane, surface links open in the system browser.
  uses: { browser: Browser },
  stores: {
    // Where agent-rendered surfaces show: inline in the timeline, or as tabs in the side panel.
    placement: Store.global(Placement, { placement: "timeline" }),
  },
  i18n: { en },
})

# GenUI plugin

`@opencode/plugin-genui` lets agents show interactive UI in the OpenCode app. The
agent writes a GenUI program in a `genui_render` call; the timeline draws it with
the app's own components while the call streams, and every call is checked so
the agent knows whether its UI rendered.

```
root = Surface([counts, actions])
$approved = 0
counts = Metrics([Metric("Approved", $approved + " of 4")])
actions = Actions([approve, apply])
approve = Button("Approve next", set($approved, $approved + 1), "primary")
apply = Button("Apply", reply("Apply the " + $approved + " approved changes"))
```

## Language

One statement per line, `name = Expression`, starting with `root = Surface(...)`.
Components take positional arguments; values are text, numbers, booleans,
`null`, lists and objects. `$name = value` declares state that lives in the
app; expressions (`+ - * / %`, comparisons, `&& || !`, `? :`) read it, and
`set`, `reset`, `reply` and `open` change it or answer the agent when a button
is pressed. There are no loops, functions or host access.

The language is ours and small on purpose: it parses while streaming, checks
statically, and has no install scripts, telemetry or third-party prompt text.

## Modules

- `catalog.ts`: every component as the Effect schema of its rendered node. The
  props struct's key order is the positional order, its types check programs,
  and the guide prints signatures from it.
- `lang.ts` and `lang/`: lexer, parser (incremental while streaming), evaluator,
  static checks and the type printer. Generic over a catalog.
- `guide.ts`: the `genui` skill, generated from the catalog and examples.
- `tools.ts`: the skill and the `genui_render` tool, which returns each problem
  by statement.
- `session.ts`: offers the tool, and adds a short reminder, only while the
  session's latest prompt came from the app (`metadata.client = "app"`).

`./genui`, `./lang` and `./catalog` are browser-safe; `session-ui` renders with
them. `.` is the server plugin.

## Tests

Run `bun test` and `bun typecheck` from this package. Every guide example must
check clean and render from every prefix as it streams.

Disable through normal configuration:

```jsonc
{ "plugins": ["-opencode.genui"] }
```

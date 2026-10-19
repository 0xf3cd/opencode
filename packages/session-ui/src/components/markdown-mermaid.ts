import type { RenderOptions } from "pele/core"

let loaded: Promise<typeof import("pele/lazy")> | undefined
let syncModule: typeof import("pele/lazy") | undefined

let sequence = 0

function renderOptions(): RenderOptions {
  return {
    idPrefix: `markdown-mermaid-${sequence++}`,
    images: false,
    linkSchemes: ["http", "https", "mailto"],
    linkRel: "noopener noreferrer",
  }
}

export function healStreamingMermaid(source: string): string {
  const lines = source.split("\n")
  let openBlocks = 0
  let openBraces = 0

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith("%%")) continue
    if (/^(subgraph|alt|opt|loop|par|critical|break|rect|box)\b/.test(line)) openBlocks++
    else if (/^end\b/.test(line) && openBlocks > 0) openBlocks--

    for (const ch of line) {
      if (ch === "{") openBraces++
      else if (ch === "}" && openBraces > 0) openBraces--
    }
  }

  if (openBlocks === 0 && openBraces === 0) return source
  let healed = source
  while (openBraces-- > 0) healed += "\n}"
  while (openBlocks-- > 0) healed += "\nend"
  return healed
}

function nonEmptySvg(result: { svg: string; width: number; height: number }, streaming: boolean): string | undefined {
  if (streaming && result.width <= 16 && result.height <= 16) return
  return result.svg
}

export function renderMermaidSvgSync(source: string, streaming = false): string | undefined {
  if (!syncModule) return
  const type = syncModule.detectType(source)
  if (!type || !syncModule.registered(type)) return

  try {
    return nonEmptySvg(syncModule.render(source, renderOptions()), streaming)
  } catch {
    if (!streaming) return
    const healed = healStreamingMermaid(source)
    if (healed === source) return
    try {
      return nonEmptySvg(syncModule.render(healed, renderOptions()), streaming)
    } catch {
      return
    }
  }
}

export async function renderMermaidSvg(source: string, streaming = false): Promise<string | undefined> {
  const pele = (syncModule ??= await (loaded ??= import("pele/lazy")))
  if (!pele.detectType(source)) return

  try {
    return nonEmptySvg(await pele.renderAsync(source, renderOptions()), streaming)
  } catch {
    if (!streaming) return
    const healed = healStreamingMermaid(source)
    if (healed === source) return
    try {
      return nonEmptySvg(await pele.renderAsync(healed, renderOptions()), streaming)
    } catch {
      return
    }
  }
}

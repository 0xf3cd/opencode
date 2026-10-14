import GithubSlugger from "github-slugger"

// Reads Markdown headings outside fenced code blocks. IDs match Astro's: GitHub slugs of the heading text,
// de-duplicated in page order.
export function markdownHeadings(source: string) {
  const slugger = new GithubSlugger()
  return source
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .split("\n")
    .reduce<{ fenced: boolean; lines: string[] }>(
      (state, line) => {
        if (/^\s*(```|~~~)/.test(line)) return { fenced: !state.fenced, lines: state.lines }
        return { fenced: state.fenced, lines: state.fenced ? state.lines : [...state.lines, line] }
      },
      { fenced: false, lines: [] },
    )
    .lines.flatMap((line) => {
      const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
      if (!match) return []
      const text = match[2]!.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "")
      return [{ depth: match[1]!.length, id: slugger.slug(text) }]
    })
}

// A translation is current when it keeps the English heading structure: the same levels in the same order.
export function sameHeadingStructure(translation: string, english: string) {
  return (
    markdownHeadings(translation)
      .map((heading) => heading.depth)
      .join() ===
    markdownHeadings(english)
      .map((heading) => heading.depth)
      .join()
  )
}

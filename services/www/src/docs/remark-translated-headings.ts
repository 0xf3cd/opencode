import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { markdownHeadings } from "./lib/headings"

interface MarkdownNode {
  type: string
  depth?: number
  data?: { hProperties?: Record<string, unknown> }
  children?: MarkdownNode[]
}

interface MarkdownFile {
  history: string[]
}

// Translated pages reuse the English heading IDs so `/page#anchor` links work in every locale. A translation whose
// heading structure no longer matches English is outdated; `lib/pages.ts` serves the English page in its place.
export default function remarkTranslatedHeadings(options: { content: string; locales: string[] }) {
  return (tree: MarkdownNode, file: MarkdownFile) => {
    const relative = path.relative(options.content, file.history[0] ?? "")
    const [locale, ...rest] = relative.split(path.sep)
    if (!locale || !options.locales.includes(locale) || rest.length === 0) return
    // A translation left behind after its English page was removed or moved is never routed.
    const source = path.join(options.content, ...rest)
    if (!existsSync(source)) return

    const english = markdownHeadings(readFileSync(source, "utf8"))
    const headings = collect(tree)
    if (headings.map((heading) => heading.depth).join() !== english.map((heading) => heading.depth).join()) {
      console.warn(`[docs] ${relative} is outdated: its headings differ from English, so the English page is served`)
      return
    }
    headings.forEach((heading, index) => {
      heading.data = { ...heading.data, hProperties: { ...heading.data?.hProperties, id: english[index]!.id } }
    })
  }
}

function collect(node: MarkdownNode): MarkdownNode[] {
  return [...(node.type === "heading" ? [node] : []), ...(node.children ?? []).flatMap(collect)]
}

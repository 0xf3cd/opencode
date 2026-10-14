export const en = {
  "page.description": "{{title}} documentation for OpenCode.",
  "page.copyMarkdown": "Copy page as Markdown",
  "page.copied": "Copied",
  "page.headingAnchor": "Link to {{heading}}",
  "page.toc": "On this page",
  "callout.note": "Note",
  "callout.tip": "Tip",
  "callout.warning": "Warning",
  "code.copy": "Copy",
  "nav.skip": "Skip to content",
  "nav.home": "OpenCode home",
  "nav.sections": "Documentation sections",
  "nav.sidebar": "Documentation",
  "nav.mobile": "{{section}} navigation",
  "nav.github": "OpenCode on GitHub",
  "nav.language": "Language",
  "search.button": "Search",
  "search.label": "Search documentation",
  "search.placeholder": "Search docs",
  "search.close": "Close search",
  "search.empty": "Start typing to search the documentation.",
  "search.noResults": "No results found.",
} as const

export type Key = keyof typeof en
export type Dict = Record<Key, string>

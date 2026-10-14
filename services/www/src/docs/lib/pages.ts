import { getCollection, type CollectionEntry } from "astro:content"
import { sameHeadingStructure } from "./headings"
import { defaultLocale, docsLocaleKeys, parseDocsPath, type DocsLocale } from "./language"

// Resolves an English slug in a locale. Untranslated pages fall back to the English entry.
export async function getDocsPage(locale: DocsLocale, slug: string) {
  const entries = await getDocsEntries()
  const english = parseDocsPath(slug).locale === defaultLocale ? entries.get(slug) : undefined
  return english && resolve(entries, locale, english)
}

// Lists every English page in every locale, including untranslated fallbacks.
export async function getDocsPages() {
  const entries = await getDocsEntries()
  const english = [...entries.values()].filter((entry) => parseDocsPath(entry.id).locale === defaultLocale)
  return docsLocaleKeys.flatMap((locale) => english.map((entry) => resolve(entries, locale, entry)))
}

async function getDocsEntries() {
  return new Map((await getCollection("docs")).map((entry) => [entry.id, entry]))
}

function resolve(entries: Map<string, CollectionEntry<"docs">>, locale: DocsLocale, english: CollectionEntry<"docs">) {
  // Content ids drop a trailing `/index`, so `zh/index.mdx` has the id `zh`.
  const candidate =
    locale === defaultLocale ? undefined : entries.get(english.id === "index" ? locale : `${locale}/${english.id}`)
  // Outdated translations fall back to English until they are updated.
  const translation =
    candidate && sameHeadingStructure(candidate.body ?? "", english.body ?? "") ? candidate : undefined
  return {
    entry: translation ?? english,
    locale,
    slug: english.id,
    fallback: locale !== defaultLocale && !translation,
  }
}

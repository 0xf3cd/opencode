import type { DocsLocale } from "../lib/language"
import { en, type Dict, type Key } from "./en"
import { zh, zhNav } from "./zh"

const base = en satisfies Dict

export function i18n(locale: DocsLocale): Dict {
  if (locale === "zh") return { ...base, ...zh }
  return base
}

function navLabels(locale: DocsLocale): Record<string, string> {
  if (locale === "zh") return zhNav
  return {}
}

export function useI18n(locale: DocsLocale) {
  const dict = i18n(locale)
  const labels = navLabels(locale)
  return {
    t(key: Key, params?: Record<string, string | number>) {
      return dict[key].replace(/\{\{(\w+)\}\}/g, (raw, name) => String(params?.[name] ?? raw))
    },
    // Untranslated navigation labels stay English.
    nav(title: string) {
      return labels[title] ?? title
    },
  }
}

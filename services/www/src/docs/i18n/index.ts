import type { DocsLocale } from "../lib/language"
import { en, type Dict, type Key } from "./en"
import { zh, zhNav } from "./zh"
import { zht, zhtNav } from "./zht"
import { ko, koNav } from "./ko"
import { de, deNav } from "./de"
import { es, esNav } from "./es"
import { fr, frNav } from "./fr"
import { it, itNav } from "./it"
import { da, daNav } from "./da"
import { ja, jaNav } from "./ja"
import { pl, plNav } from "./pl"
import { ru, ruNav } from "./ru"
import { uk, ukNav } from "./uk"
import { ar, arNav } from "./ar"
import { no, noNav } from "./no"
import { br, brNav } from "./br"
import { th, thNav } from "./th"
import { tr, trNav } from "./tr"

const dictionaries = {
  en,
  zh,
  zht,
  ko,
  de,
  es,
  fr,
  it,
  da,
  ja,
  pl,
  ru,
  uk,
  ar,
  no,
  br,
  th,
  tr,
} satisfies Record<DocsLocale, Dict>

// Header and sidebar labels keyed by their English text. English labels are used as-is.
const navigation = {
  en: {},
  zh: zhNav,
  zht: zhtNav,
  ko: koNav,
  de: deNav,
  es: esNav,
  fr: frNav,
  it: itNav,
  da: daNav,
  ja: jaNav,
  pl: plNav,
  ru: ruNav,
  uk: ukNav,
  ar: arNav,
  no: noNav,
  br: brNav,
  th: thNav,
  tr: trNav,
} satisfies Record<DocsLocale, Record<string, string>>

export function i18n(locale: DocsLocale): Dict {
  return dictionaries[locale]
}

export function useI18n(locale: DocsLocale) {
  const dict = i18n(locale)
  const labels: Record<string, string> = navigation[locale]
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

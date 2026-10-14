// Locale codes match the opencode.ai website. The code is the URL segment, the `content/<code>/` folder, and the
// `i18n/<code>.ts` file name. English is the default locale and has no URL segment.
export const docsLocales = {
  en: { label: "English", tag: "en", v1: "", dir: "ltr" },
  zh: { label: "简体中文", tag: "zh-Hans", v1: "zh-cn", dir: "ltr" },
  zht: { label: "繁體中文", tag: "zh-Hant", v1: "zh-tw", dir: "ltr" },
  ko: { label: "한국어", tag: "ko", v1: "ko", dir: "ltr" },
  de: { label: "Deutsch", tag: "de", v1: "de", dir: "ltr" },
  es: { label: "Español", tag: "es", v1: "es", dir: "ltr" },
  fr: { label: "Français", tag: "fr", v1: "fr", dir: "ltr" },
  it: { label: "Italiano", tag: "it", v1: "it", dir: "ltr" },
  da: { label: "Dansk", tag: "da", v1: "da", dir: "ltr" },
  ja: { label: "日本語", tag: "ja", v1: "ja", dir: "ltr" },
  pl: { label: "Polski", tag: "pl", v1: "pl", dir: "ltr" },
  ru: { label: "Русский", tag: "ru", v1: "ru", dir: "ltr" },
  uk: { label: "Українська", tag: "uk", v1: "", dir: "ltr" },
  ar: { label: "العربية", tag: "ar", v1: "ar", dir: "rtl" },
  no: { label: "Norsk", tag: "no", v1: "nb", dir: "ltr" },
  br: { label: "Português (Brasil)", tag: "pt-BR", v1: "pt-br", dir: "ltr" },
  th: { label: "ไทย", tag: "th", v1: "th", dir: "ltr" },
  tr: { label: "Türkçe", tag: "tr", v1: "tr", dir: "ltr" },
}

export type DocsLocale = keyof typeof docsLocales

export const defaultLocale: DocsLocale = "en"

// Shared with the opencode.ai website, so a language chosen on either site carries over.
export const LOCALE_COOKIE = "oc_locale"

export function localeCookie(locale: DocsLocale) {
  return `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`
}

export function isDocsLocale(value: string): value is DocsLocale {
  return Object.hasOwn(docsLocales, value)
}

export const docsLocaleKeys = Object.keys(docsLocales).filter(isDocsLocale)

// Splits a docs-root-relative path such as `zh/cli/tui` into its locale and English slug.
export function parseDocsPath(path: string) {
  const [first = "", ...rest] = path.split("/")
  if (first !== defaultLocale && isDocsLocale(first)) return { locale: first, slug: rest.join("/") || "index" }
  return { locale: defaultLocale, slug: path || "index" }
}

export function docsLocaleFromUrl(url: URL) {
  return parseDocsPath(url.pathname.slice(import.meta.env.BASE_URL.length).replace(/^docs(-index)?(\/|$)/, "")).locale
}

// Adds the locale segment to an absolute docs URL such as `/v2/docs/config/#paths`.
export function localizeDocsHref(href: string, locale: DocsLocale) {
  const root = `${import.meta.env.BASE_URL}docs`
  if (locale === defaultLocale) return href
  if (href !== root && !href.startsWith(`${root}/`) && !href.startsWith(`${root}#`)) return href
  const rest = href.slice(root.length)
  return `${root}/${locale}${rest.startsWith("/") ? rest : `/${rest}`}`
}

// Same order as `localeFromRequest` on the opencode.ai website: URL prefix, then cookie, then Accept-Language.
// Values the docs do not support yet, such as `ko`, are skipped.
export function docsLocaleFromRequest(request: Request) {
  const fromPath = docsLocaleFromUrl(new URL(request.url))
  if (fromPath !== defaultLocale) return fromPath
  return (
    localeFromCookieHeader(request.headers.get("cookie")) ??
    localeFromAcceptLanguage(request.headers.get("accept-language"))
  )
}

function localeFromCookieHeader(header: string | null) {
  const raw = header
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${LOCALE_COOKIE}=`))
    ?.slice(LOCALE_COOKIE.length + 1)
  const value = raw && decodeURIComponent(raw)
  return value && isDocsLocale(value) ? value : undefined
}

function localeFromAcceptLanguage(header: string | null) {
  return (
    (header ?? "")
      .split(",")
      .map((item) => {
        const parts = item.split(";").map((part) => part.trim())
        const q = parts.find((part) => part.startsWith("q="))?.slice(2)
        return { language: parts[0] ?? "", q: q ? Number.parseFloat(q) : 1 }
      })
      .filter((item) => item.language && item.language !== "*")
      .sort((a, b) => b.q - a.q)
      .map((item) => matchLocale(item.language))
      .find((locale) => locale !== undefined) ?? defaultLocale
  )
}

// Maps a language tag to a website locale code, as the website's `match` does.
function matchLocale(language: string) {
  const value = language.toLowerCase()
  const base = value.split("-")[0] ?? ""
  const code = value.startsWith("zh") ? (/hant|-tw|-hk|-mo/.test(value) ? "zht" : "zh") : (localeAliases[base] ?? base)
  return isDocsLocale(code) ? code : undefined
}

const localeAliases: Record<string, string> = { pt: "br", nb: "no", nn: "no" }

// V1 docs use their own locale segments, for example `/docs/zh-cn/`. Locales V1 never had link to the V1 root.
export function v1DocsHref(locale: DocsLocale) {
  const segment = docsLocales[locale].v1
  return segment ? `/docs/${segment}/` : "/docs"
}

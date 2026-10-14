import { defineMiddleware } from "astro:middleware"
import {
  defaultLocale,
  docsLocaleFromRequest,
  docsLocaleFromUrl,
  localeCookie,
  localizeDocsHref,
  type DocsLocale,
} from "./docs/lib/language"

// Follows the opencode.ai /data proxy: decide the locale on every request, redirect unprefixed pages to the
// preferred locale, then serve the page from a cache keyed by its locale-specific URL.
export const onRequest = defineMiddleware(async (context, next) => {
  if (context.isPrerendered || !isDocsPage(context.request)) return next()

  const url = new URL(context.request.url)
  const locale = docsLocaleFromRequest(context.request)
  const prefixed = docsLocaleFromUrl(url) !== defaultLocale
  if (!prefixed && locale !== defaultLocale) {
    return new Response(null, {
      status: 308,
      headers: localeHeaders(
        { Location: localizeDocsHref(`${url.pathname}${url.search}`, locale), "Cache-Control": "no-store" },
        locale,
      ),
    })
  }

  const result = await cached(context.request, next)
  const headers = localeHeaders(result.response.headers, prefixed ? locale : undefined)
  if (result.status) headers.set("x-opencode-docs-cache", result.status)
  return new Response(result.response.body, {
    status: result.response.status,
    statusText: result.response.statusText,
    headers,
  })
})

function isDocsPage(request: Request) {
  const pathname = new URL(request.url).pathname
  const root = `${import.meta.env.BASE_URL}docs`
  const accept = request.headers.get("accept") ?? ""
  if (request.method !== "GET" && request.method !== "HEAD") return false
  if (pathname !== root && !pathname.startsWith(`${root}/`)) return false
  if (pathname.startsWith(`${root}/pagefind/`) || pathname.split("/").at(-1)?.includes(".")) return false
  // Markdown responses are not localized redirects or cached HTML.
  return !accept.includes("text/markdown") && !accept.includes("text/x-markdown")
}

async function cached(request: Request, next: () => Promise<Response>) {
  if (!import.meta.env.PROD || request.method !== "GET" || !isCloudflareCacheStorage(caches)) {
    return { response: await next() }
  }
  const key = new Request(new URL(new URL(request.url).pathname, request.url))
  const hit = await caches.default.match(key)
  if (hit) return { response: hit, status: "HIT" }
  const response = await next()
  if (response.status === 200) await caches.default.put(key, response.clone())
  return { response, status: "MISS" }
}

function isCloudflareCacheStorage(storage: CacheStorage): storage is CacheStorage & { default: Cache } {
  return "default" in storage
}

// Pages vary by the locale cookie and Accept-Language, and visiting a localized page remembers its locale.
function localeHeaders(init: HeadersInit, locale?: DocsLocale) {
  const headers = new Headers(init)
  headers.set("Vary", "Accept, Accept-Language, Cookie")
  if (locale) headers.append("Set-Cookie", localeCookie(locale))
  return headers
}

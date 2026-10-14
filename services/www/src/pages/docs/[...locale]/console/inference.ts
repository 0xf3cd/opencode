import type { APIRoute } from "astro"
import { defaultLocale, isDocsLocale } from "../../../../docs/lib/language"
import { docsHref } from "../../../../docs/lib/navigation"

export const prerender = false

export const GET: APIRoute = (context) => {
  const locale = context.params.locale ?? defaultLocale
  if (!isDocsLocale(locale)) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } })
  return context.redirect(docsHref("console/api/inference", locale), 301)
}

// Only direct Cloudflare requests can supply visitor-IP evidence to the private inference binding.
// Worker subrequests can derive CF-Connecting-IP from script-controlled X-Real-IP.
export function inferenceHeaders(request: Request & { readonly cf?: unknown }) {
  const ip =
    request.cf !== undefined && !["cf-worker", "cf-ew-via", "x-real-ip"].some((name) => request.headers.has(name))
      ? request.headers.get("cf-connecting-ip")
      : null
  const headers = new Headers(request.headers)
  for (const name of [
    "x-real-ip",
    "x-forwarded-for",
    "forwarded",
    "cf-connecting-ip",
    "cf-connecting-ipv6",
    "x-zen-ip",
  ])
    headers.delete(name)
  if (ip) headers.set("x-real-ip", ip)
  return headers
}

import { Resource } from "sst/resource"
import { subscribeToNewsletter } from "../../lib/opensend"

export async function POST(event: { request: Request }) {
  const contentType = event.request.headers.get("content-type") ?? ""
  if (!contentType.includes("multipart/form-data") && !contentType.includes("application/x-www-form-urlencoded")) {
    return Response.json({ error: "Email address is required" }, { status: 400 })
  }

  const form = await event.request.formData()
  const emailAddress = form.get("email")
  if (typeof emailAddress !== "string" || emailAddress.trim().length === 0) {
    return Response.json({ error: "Email address is required" }, { status: 400 })
  }

  const subscribed = await subscribeToNewsletter(
    Resource.OPENSEND_API_KEY.value,
    emailAddress,
    "stats newsletter signup",
  )
  if (!subscribed) return Response.json({ error: "Failed to subscribe" }, { status: 502 })
  return Response.json({ success: true })
}

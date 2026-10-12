const OPENSEND_URL = "https://opensend.anoma.ly"
// TODO: replace with the OpenSend newsletter contact list ID before merging.
const NEWSLETTER_LIST_ID = "REPLACE_WITH_OPENSEND_NEWSLETTER_LIST_ID"

// Creates (or finds) the contact, records marketing consent from the signup form,
// and adds it to the newsletter list.
export async function subscribeToNewsletter(apiKey: string, emailAddress: string, source: string) {
  const email = emailAddress.trim()
  const request = (path: string, init?: RequestInit) =>
    fetch(`${OPENSEND_URL}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    })

  const created = await request("/v1/contacts", { method: "POST", body: JSON.stringify({ email }) })
  const contactId = created.ok
    ? ((await created.json()) as { id: string }).id
    : created.status === 409
      ? await request(`/v1/contacts?${new URLSearchParams({ search: email, limit: "100" })}`)
          .then((response) =>
            response.ok ? (response.json() as Promise<{ data: { id: string; email: string }[] }>) : undefined,
          )
          .then((page) => page?.data.find((contact) => contact.email.toLowerCase() === email.toLowerCase())?.id)
      : undefined
  if (!contactId) {
    console.error("OpenSend contact create failed:", created.status, await created.text())
    return false
  }

  // Submitting the signup form is an explicit opt-in, so it may resubscribe a prior opt-out.
  const consent = await request(`/v1/contacts/${contactId}/consent`, {
    method: "POST",
    body: JSON.stringify({ status: "subscribed", source, confirmResubscribe: true }),
  })
  if (!consent.ok) {
    console.error("OpenSend consent update failed:", consent.status, await consent.text())
    return false
  }

  const member = await request(`/v1/lists/${NEWSLETTER_LIST_ID}/members`, {
    method: "POST",
    body: JSON.stringify({ contactIds: [contactId] }),
  })
  if (!member.ok) console.error("OpenSend list add failed:", member.status, await member.text())
  return member.ok
}

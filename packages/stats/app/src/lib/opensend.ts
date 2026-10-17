const OPENSEND_URL = "https://opensend.anoma.ly"
// "OpenCode - Newsletter MASTER" in OpenSend.
const NEWSLETTER_LIST_ID = "lst_83ab8cf3264d40e1b6b01fe5c2bd94bb"

// Creates (or finds) the contact, records marketing consent from the signup form,
// and adds it to the newsletter list.
export async function subscribeToNewsletter(apiKey: string, emailAddress: string, source: string) {
  const email = emailAddress.trim()
  const request = (path: string, init?: RequestInit) =>
    fetch(`${OPENSEND_URL}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    })

  // OpenSend answers 409 CONTACT_EXISTS for an address it already has.
  const created = await request("/v1/contacts", { method: "POST", body: JSON.stringify({ email }) })
  const contactId = created.ok
    ? ((await created.json()) as { id: string }).id
    : created.status === 409
      ? await request(`/v1/contacts?${new URLSearchParams({ email })}`)
          .then((response) => (response.ok ? (response.json() as Promise<{ data: { id: string }[] }>) : undefined))
          .then((page) => page?.data[0]?.id)
      : undefined
  if (!contactId) {
    console.error("OpenSend contact create failed:", created.status, await created.text())
    return false
  }

  // Anyone can type any address into the form, so it never overrides an earlier opt-out.
  const consent = await request(`/v1/contacts/${contactId}/consent`, {
    method: "POST",
    body: JSON.stringify({ status: "subscribed", source }),
  })
  if (!consent.ok) {
    const body = await consent.text()
    if (!body.includes('"RESUBSCRIBE_CONFIRMATION_REQUIRED"')) {
      console.error("OpenSend consent update failed:", consent.status, body)
      return false
    }
  }

  const member = await request(`/v1/lists/${NEWSLETTER_LIST_ID}/members`, {
    method: "POST",
    body: JSON.stringify({ contactIds: [contactId] }),
  })
  if (!member.ok) console.error("OpenSend list add failed:", member.status, await member.text())
  return member.ok
}

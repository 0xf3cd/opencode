import { afterEach, describe, expect, test } from "bun:test"
import { subscribeToNewsletter } from "../src/lib/opensend"

const realFetch = globalThis.fetch

function mockOpenSend(responses: Record<string, Response>) {
  const calls: { method: string; path: string; body?: unknown }[] = []
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const method = init?.method ?? "GET"
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return responses[`${method} ${url.pathname}`] ?? new Response("not found", { status: 404 })
  }) as typeof fetch
  return calls
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("subscribeToNewsletter", () => {
  test("creates the contact, records consent, and adds it to the list", async () => {
    const calls = mockOpenSend({
      "POST /v1/contacts": Response.json({ id: "contact_1" }, { status: 201 }),
      "POST /v1/contacts/contact_1/consent": Response.json({}),
      "POST /v1/lists/REPLACE_WITH_OPENSEND_NEWSLETTER_LIST_ID/members": Response.json({ added: 1 }),
    })

    expect(await subscribeToNewsletter("key", " a@example.com ", "test")).toBe(true)
    expect(calls).toEqual([
      { method: "POST", path: "/v1/contacts", body: { email: "a@example.com" } },
      {
        method: "POST",
        path: "/v1/contacts/contact_1/consent",
        body: { status: "subscribed", source: "test", confirmResubscribe: true },
      },
      {
        method: "POST",
        path: "/v1/lists/REPLACE_WITH_OPENSEND_NEWSLETTER_LIST_ID/members",
        body: { contactIds: ["contact_1"] },
      },
    ])
  })

  test("reuses an existing contact when create conflicts", async () => {
    const calls = mockOpenSend({
      "POST /v1/contacts": Response.json({ error: { code: "CONFLICT" } }, { status: 409 }),
      "GET /v1/contacts": Response.json({
        data: [
          { id: "contact_other", email: "xa@example.com" },
          { id: "contact_2", email: "A@example.com" },
        ],
        nextCursor: null,
      }),
      "POST /v1/contacts/contact_2/consent": Response.json({}),
      "POST /v1/lists/REPLACE_WITH_OPENSEND_NEWSLETTER_LIST_ID/members": Response.json({ added: 0 }),
    })

    expect(await subscribeToNewsletter("key", "a@example.com", "test")).toBe(true)
    expect(calls.at(-1)?.body).toEqual({ contactIds: ["contact_2"] })
  })

  test("stops when the contact cannot be created", async () => {
    const calls = mockOpenSend({ "POST /v1/contacts": Response.json({}, { status: 422 }) })

    expect(await subscribeToNewsletter("key", "bad", "test")).toBe(false)
    expect(calls).toHaveLength(1)
  })
})

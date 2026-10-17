import { afterEach, describe, expect, test } from "bun:test"
import { subscribeToNewsletter } from "../src/lib/opensend"

const realFetch = globalThis.fetch
const LIST = "lst_83ab8cf3264d40e1b6b01fe5c2bd94bb"

function mockOpenSend(responses: Record<string, Response>) {
  const calls: { method: string; path: string; query: string; body?: unknown }[] = []
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const method = init?.method ?? "GET"
    calls.push({
      method,
      path: url.pathname,
      query: url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return responses[`${method} ${url.pathname}`] ?? new Response("not found", { status: 404 })
  }) as typeof fetch
  return calls
}

const apiError = (status: number, code: string) =>
  Response.json({ error: { code, message: code, requestId: "req_1", retryable: false } }, { status })

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("subscribeToNewsletter", () => {
  test("creates the contact, records consent, and adds it to the list", async () => {
    const calls = mockOpenSend({
      "POST /v1/contacts": Response.json({ id: "contact_1" }, { status: 201 }),
      "POST /v1/contacts/contact_1/consent": Response.json({}),
      [`POST /v1/lists/${LIST}/members`]: Response.json({ added: 1 }),
    })

    expect(await subscribeToNewsletter("key", " a@example.com ", "test")).toBe(true)
    expect(calls).toEqual([
      { method: "POST", path: "/v1/contacts", query: "", body: { email: "a@example.com" } },
      {
        method: "POST",
        path: "/v1/contacts/contact_1/consent",
        query: "",
        body: { status: "subscribed", source: "test" },
      },
      { method: "POST", path: `/v1/lists/${LIST}/members`, query: "", body: { contactIds: ["contact_1"] } },
    ])
  })

  test("looks up an existing contact by exact email when create conflicts", async () => {
    const calls = mockOpenSend({
      "POST /v1/contacts": apiError(409, "CONTACT_EXISTS"),
      "GET /v1/contacts": Response.json({ data: [{ id: "contact_2", email: "a@example.com" }], nextCursor: null }),
      "POST /v1/contacts/contact_2/consent": Response.json({}),
      [`POST /v1/lists/${LIST}/members`]: Response.json({ added: 0 }),
    })

    expect(await subscribeToNewsletter("key", "a@example.com", "test")).toBe(true)
    expect(calls[1]).toMatchObject({ method: "GET", path: "/v1/contacts", query: "?email=a%40example.com" })
    expect(calls.at(-1)?.body).toEqual({ contactIds: ["contact_2"] })
  })

  test("keeps an earlier opt-out and still adds the contact to the list", async () => {
    const calls = mockOpenSend({
      "POST /v1/contacts": apiError(409, "CONTACT_EXISTS"),
      "GET /v1/contacts": Response.json({ data: [{ id: "contact_3", email: "a@example.com" }], nextCursor: null }),
      "POST /v1/contacts/contact_3/consent": apiError(409, "RESUBSCRIBE_CONFIRMATION_REQUIRED"),
      [`POST /v1/lists/${LIST}/members`]: Response.json({ added: 0 }),
    })

    expect(await subscribeToNewsletter("key", "a@example.com", "test")).toBe(true)
    expect(calls[2]?.body).toEqual({ status: "subscribed", source: "test" })
    expect(calls.at(-1)?.path).toBe(`/v1/lists/${LIST}/members`)
  })

  test("stops when consent fails for another reason", async () => {
    const calls = mockOpenSend({
      "POST /v1/contacts": Response.json({ id: "contact_4" }, { status: 201 }),
      "POST /v1/contacts/contact_4/consent": apiError(500, "CONSENT_WRITE_FAILED"),
    })

    expect(await subscribeToNewsletter("key", "a@example.com", "test")).toBe(false)
    expect(calls).toHaveLength(2)
  })

  test("stops when the contact cannot be created", async () => {
    const calls = mockOpenSend({ "POST /v1/contacts": apiError(422, "VALIDATION_ERROR") })

    expect(await subscribeToNewsletter("key", "bad", "test")).toBe(false)
    expect(calls).toHaveLength(1)
  })
})

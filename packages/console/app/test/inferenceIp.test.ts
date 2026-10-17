import { expect, test } from "bun:test"
import { inferenceHeaders } from "../src/lib/inference-ip"

test.each(["203.0.113.10", "2001:db8::10"])("forwards only the direct edge address: %s", (ip) => {
  const request = Object.assign(
    new Request("https://opencode.ai/zen/v1/models", {
      headers: {
        "cf-connecting-ip": ip,
        "cf-connecting-ipv6": "2001:db8::bad",
        "x-forwarded-for": "198.51.100.1",
        forwarded: "for=198.51.100.1",
        "x-zen-ip": "198.51.100.1",
        authorization: "Bearer test-only",
      },
    }),
    { cf: { colo: "TEST" } },
  )
  expect([...inferenceHeaders(request)]).toEqual([
    ["authorization", "Bearer test-only"],
    ["x-real-ip", ip],
  ])
})

test.each(["cf-worker", "cf-ew-via", "x-real-ip"])("rejects relay evidence: %s", (name) => {
  const request = Object.assign(
    new Request("https://opencode.ai/zen/v1/models", {
      headers: { "cf-connecting-ip": "203.0.113.10", [name]: "spoofed" },
    }),
    { cf: { colo: "TEST" } },
  )
  expect(inferenceHeaders(request).has("x-real-ip")).toBe(false)
  expect(inferenceHeaders(request).has("cf-connecting-ip")).toBe(false)
})

test("missing runtime metadata cannot turn headers into trusted evidence", () => {
  const request = new Request("http://origin/zen/v1/models", {
    headers: { "cf-connecting-ip": "203.0.113.10" },
  })
  expect([...inferenceHeaders(request)]).toEqual([])
})

test("missing edge IP strips claims rather than retaining a fallback", () => {
  const request = Object.assign(
    new Request("https://opencode.ai/zen/v1/models", {
      headers: { "x-forwarded-for": "198.51.100.1", "cf-connecting-ipv6": "2001:db8::1" },
    }),
    { cf: { colo: "TEST" } },
  )
  expect([...inferenceHeaders(request)]).toEqual([])
})

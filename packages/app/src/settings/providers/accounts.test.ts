import { describe, expect, test } from "bun:test"
import type { IntegrationInfo } from "@opencode/client/promise"
import { activeProviderAccount, goAccountSource, isFinalProviderAccountRemoval, providerAccounts } from "./accounts"

const integration = (connections: IntegrationInfo["connections"]): IntegrationInfo => ({
  id: "openai",
  name: "OpenAI",
  methods: [],
  connections,
})

const namedIntegration = (value: Partial<IntegrationInfo> & Pick<IntegrationInfo, "id" | "name">): IntegrationInfo => ({
  methods: [],
  connections: [],
  ...value,
})

test("provider accounts keep the server's active-first credential order and ignore environment keys", () => {
  const value = integration([
    { type: "credential", id: "cred_work", label: "Work", method: "key" },
    { type: "env", name: "OPENAI_API_KEY" },
    { type: "credential", id: "cred_personal", label: "Personal", method: "oauth" },
  ])

  expect(providerAccounts(value)).toEqual([
    { type: "credential", id: "cred_work", label: "Work", method: "key" },
    { type: "credential", id: "cred_personal", label: "Personal", method: "oauth" },
  ])
  expect(activeProviderAccount(value)).toEqual({ type: "credential", id: "cred_work", label: "Work", method: "key" })

  const env = integration([{ type: "env", name: "OPENAI_API_KEY" }])
  expect(providerAccounts(env)).toEqual([])
  expect(activeProviderAccount(env)).toBeUndefined()
  expect(providerAccounts(undefined)).toEqual([])
})

describe("goAccountSource", () => {
  const consoleAccount = namedIntegration({
    id: "opencode",
    name: "OpenCode Console",
    connections: [{ type: "credential", method: "oauth", id: "cred_alpha", label: "Alpha" }],
  })

  test("reports api when a dedicated Go API key is active alongside an OpenCode account", () => {
    const go = namedIntegration({
      id: "opencode-go",
      name: "OpenCode Go",
      methods: [
        { type: "oauth", id: "device", integrationID: "opencode", label: "Sign in with your OpenCode account" },
        { type: "key", label: "Use an API key" },
      ],
      connections: [{ type: "credential", method: "key", id: "cred_go", label: "OpenCode Go" }],
    })

    expect(goAccountSource(go, [consoleAccount, go])).toBe("api")
  })

  test("reports account after the Go API key is removed and Go falls back to the OpenCode account", () => {
    const go = namedIntegration({
      id: "opencode-go",
      name: "OpenCode Go",
      methods: [
        { type: "oauth", id: "device", integrationID: "opencode", label: "Sign in with your OpenCode account" },
        { type: "key", label: "Use an API key" },
      ],
      connections: [{ type: "credential", method: "oauth", id: "cred_alpha", label: "Alpha" }],
    })

    expect(goAccountSource(go, [consoleAccount, go])).toBe("account")
  })

  test("reports account when Go delegates to a Console service-account key", () => {
    const consoleWithKey = namedIntegration({
      id: "opencode",
      name: "OpenCode Console",
      connections: [
        { type: "credential", method: "key", id: "cred_console_key", label: "Beta Key" },
        { type: "credential", method: "oauth", id: "cred_alpha", label: "Alpha" },
      ],
    })

    const go = namedIntegration({
      id: "opencode-go",
      name: "OpenCode Go",
      methods: [
        { type: "oauth", id: "device", integrationID: "opencode", label: "Sign in with your OpenCode account" },
        { type: "key", label: "Use an API key" },
      ],
      connections: consoleWithKey.connections,
    })

    expect(goAccountSource(go, [consoleWithKey, go])).toBe("account")
  })

  test("keeps the Go account view open when removing a Go API key falls back to the OpenCode account", () => {
    const goKey = { type: "credential" as const, method: "key" as const, id: "cred_go", label: "OpenCode Go" }
    const alpha = { type: "credential" as const, method: "oauth" as const, id: "cred_alpha", label: "Alpha" }

    const goWithKey = namedIntegration({
      id: "opencode-go",
      name: "OpenCode Go",
      methods: [
        { type: "oauth", id: "device", integrationID: "opencode", label: "Sign in with your OpenCode account" },
        { type: "key", label: "Use an API key" },
      ],
      connections: [goKey],
    })

    const goWithAccount = namedIntegration({
      ...goWithKey,
      connections: [alpha],
    })

    expect(isFinalProviderAccountRemoval(goWithKey, [consoleAccount, goWithKey], goKey)).toBe(false)
    expect(isFinalProviderAccountRemoval(goWithAccount, [consoleAccount, goWithAccount], alpha)).toBe(true)
  })
})

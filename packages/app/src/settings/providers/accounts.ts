import type { ConnectionInfo, IntegrationInfo } from "@opencode/client/promise"

export type ProviderAccount = Extract<ConnectionInfo, { type: "credential" }>

export function providerAccounts(integration: IntegrationInfo | undefined) {
  return integration?.connections.filter((connection): connection is ProviderAccount => connection.type === "credential") ?? []
}

export function activeProviderAccount(integration: IntegrationInfo | undefined) {
  return providerAccounts(integration)[0]
}

export function goAccountSource(
  integration: IntegrationInfo | undefined,
  list: readonly IntegrationInfo[] = [],
): "api" | "account" | undefined {
  if (integration?.id !== "opencode-go") return undefined
  const active = activeProviderAccount(integration)

  if (!active) return undefined
  const targetID = integration.methods.find((method) => method.type === "oauth")?.integrationID ?? "opencode"
  const canonical = list.find((item) => item.id === targetID)
  const delegated = canonical ? providerAccounts(canonical).some((item) => item.id === active.id) : false

  if (!delegated && active.method === "key") return "api"

  return "account"
}

export function isFinalProviderAccountRemoval(
  integration: IntegrationInfo | undefined,
  list: readonly IntegrationInfo[],
  account: ProviderAccount,
) {
  const accounts = providerAccounts(integration)

  if (accounts.length !== 1) return false

  if (integration?.id !== "opencode-go") return true
  const targetID = integration.methods.find((method) => method.type === "oauth")?.integrationID ?? "opencode"
  const canonical = list.find((item) => item.id === targetID)

  return !canonical || !providerAccounts(canonical).some((item) => item.id !== account.id)
}

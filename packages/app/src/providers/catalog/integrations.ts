import { useServerSDK } from "@/runtime/server/client"
import { useData } from "@/runtime/server/current"
import { createEffect, onCleanup, type Accessor } from "solid-js"

export function useIntegrations(directory: Accessor<string | undefined>) {
  const serverSDK = useServerSDK()
  const data = useData()

  createEffect(() => {
    if (serverSDK.connection.status() !== "connected") return
    const value = directory()
    let stale = false
    onCleanup(() => {
      stale = true
    })
    void (async () => {
      const ref = value ? { directory: value } : undefined

      if (!ref) await data.location.syncInfo()

      if (stale) return
      await data.location.integration.sync(ref ?? data.location.default())
    })().catch(() => undefined)
  })

  const location = () => {
    const value = directory()

    return value ? { directory: value } : undefined
  }

  return {
    ready: () => data.location.integration.list(location()) !== undefined,
    list: () => data.location.integration.list(location()) ?? [],
  }
}

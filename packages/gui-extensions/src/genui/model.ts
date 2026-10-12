import { onCleanup } from "solid-js"
import { Option, Schema } from "effect"
import { GenUILibrary } from "@opencode/plugin-genui/library"
import { GenUI } from "@opencode/plugin-genui/rpc"
import { currentStreamingInput } from "@opencode/session-ui/message"
import { genuiReplyText, type GenUIReply } from "@opencode/session-ui/genui"
import { showToast } from "@opencode/ui/toast"
import { createKeyed, type SessionRef, type SetupContext } from "../sdk"
import type definition from "./index"

/** A surface as the session's latest render call for it describes it, possibly still streaming. */
export type Surface = {
  readonly id: string
  readonly title: string
  readonly code: string
  /** The call is still being written or run. */
  readonly live: boolean
}

const decodeInput = Schema.decodeUnknownOption(GenUILibrary.RenderInput)

/**
 * Keeps a lease on every session with an open shell tab, so the agent sees genui tools while the user can see its
 * surfaces. Surfaces themselves come from the session's own render calls, which stream as the model writes them.
 */
export function createGenUI(ctx: SetupContext<typeof definition>) {
  // Lease key (session and directory) → its abort. A moved session re-attaches in its new location.
  const leases = new Map<string, AbortController>()

  onCleanup(() => {
    leases.forEach((lease) => lease.abort())
    leases.clear()
  })

  const attachable = () =>
    ctx.sessions.list().flatMap((session) => {
      const directory = session.location?.directory

      return session.pending || !directory ? [] : [{ key: `${session.key}\n${directory}`, session, directory }]
    })

  // Syncs the leases with the open sessions. Each lease runs outside Solid until its session's tab closes.
  const reconcile = () => {
    const wanted = new Map(attachable().map((entry) => [entry.key, entry]))

    leases.forEach((lease, key) => {
      if (wanted.has(key)) return
      lease.abort()
      leases.delete(key)
    })
    wanted.forEach((entry, key) => {
      if (!leases.has(key)) leases.set(key, attach(entry.session, entry.directory))
    })
  }

  createKeyed(
    () =>
      attachable()
        .map((entry) => entry.key)
        .join("\n\n"),
    reconcile,
    { otherwise: reconcile },
  )

  const attach = (session: SessionRef, directory: string) => {
    const lease = new AbortController()
    const signal = AbortSignal.any([lease.signal, ctx.signal])
    const options = { location: { directory } }
    // Read from the live server ref each time: a restarted server gets a new client under the same id.
    const rpc = () => session.server.client.rpc(GenUI.Definition)
    const attachment = { sessionID: session.id, connectionID: crypto.randomUUID() }

    // A server without the plugin rejects attach; retrying slowly costs nothing and picks it up after an update.
    void (async () => {
      while (!signal.aborted) {
        const renew = await rpc()
          .attach({ ...attachment, version: 2 }, { ...options, signal })
          .then(
            (result) => result.renewMs,
            () => GenUI.RENEW_MS * 4,
          )

        await wait(renew, signal)
      }
    })()

    signal.addEventListener(
      "abort",
      () =>
        void rpc()
          .detach(attachment, options)
          .catch(() => undefined),
      { once: true },
    )

    return lease
  }

  return {
    /** The session's surfaces in order of first render; a later call for the same surface replaces its content. */
    surfaces: (session: SessionRef): readonly Surface[] => {
      const surfaces = new Map<string, Surface>()

      session.server.data.session.message.list(session.id).forEach((message) => {
        if (message.type !== "assistant") return
        message.content.forEach((part) => {
          if (part.type !== "tool" || part.name !== GenUI.RENDER_TOOL || part.state.status === "error") return
          const input = Option.getOrElse(decodeInput(currentStreamingInput(part)), (): GenUILibrary.RenderInput => ({}))
          const id = input.surfaceID ?? GenUI.surfaceFor(part.id)

          surfaces.set(id, {
            id,
            title: input.title ?? "",
            code: input.code ?? "",
            live: part.state.status === "streaming" || part.state.status === "running",
          })
        })
      })

      return [...surfaces.values()]
    },
    reply: (session: SessionRef, title: string, reply: GenUIReply) =>
      session.server.client.session
        .prompt({ sessionID: session.id, text: genuiReplyText(reply, ctx.t("reply.values", { title })) })
        .then(
          () => true,
          () => {
            showToast({ title: ctx.t("surface.failed") })

            return false
          },
        ),
    open: (session: SessionRef, url: string) => {
      if (!/^https?:\/\//iu.test(url)) return
      const browser = ctx.uses.browser()

      if (browser.status === "active" && browser.value.canOpen(session, url)) {
        browser.value.open(session, url)

        return
      }

      ctx.system.openExternal(url)
    },
  }
}

export type GenUIModel = ReturnType<typeof createGenUI>

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)

    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

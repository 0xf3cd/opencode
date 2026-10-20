/** @jsxImportSource @opentui/solid */
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import type { FormFields, LocationRef } from "@opencode/client"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { DialogIntegration } from "../../../src/component/dialog-integration"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { LocationProvider, useLocation } from "../../../src/context/location"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { emptyThemeSource } from "../../fixture/fixture"
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("renders account management with an uncategorized add row and marks the active credential", async () => {
  const fixture = await renderIntegration()

  try {
    const frame = fixture.app.captureCharFrame()
    const lines = frame.split("\n")

    expect(frame.indexOf("Add account")).toBeLessThan(frame.indexOf("Connected accounts"))
    expect(frame.indexOf("Connected accounts")).toBeLessThan(frame.indexOf("Personal"))
    expect(frame.indexOf("Personal")).toBeLessThan(frame.indexOf("Work"))
    expect(lines.find((line) => line.includes("Personal"))).toContain("\u25cf")
    expect(lines.find((line) => line.includes("Work"))).not.toContain("\u25cf")
    expect(frame).not.toContain("OPENAI_API_KEY")
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("opens the key connection prompt from the initially focused add account row", async () => {
  const fixture = await renderIntegration()

  try {
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitForFrame((frame) => frame.includes("API key") && !frame.includes("Connected accounts"))

    expect(fixture.requests).toEqual([])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("skips hidden authentication fields and sends their defaults", async () => {
  const fixture = await renderIntegration(undefined, [
    { type: "string", key: "server", title: "Console URL", hidden: true, default: "https://example.com/console" },
    { type: "string", key: "optional", hidden: true },
  ])

  try {
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    expect(fixture.app.captureCharFrame()).not.toContain("Console URL")
    await fixture.app.mockInput.typeText("test-key")
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.requests.length === 1)
    expect(fixture.requests).toEqual([
      {
        method: "POST",
        path: "/api/integration/openai/connect/key",
        body: { key: "test-key", answer: { server: "https://example.com/console" } },
      },
    ])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("switches the selected account with enter and keeps the reactive account manager open", async () => {
  const fixture = await renderIntegration()

  try {
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressEnter()

    await fixture.app.waitForFrame((frame) => {
      const line = frame.split("\n").find((entry) => entry.includes("Work"))
      return frame.includes("Connected accounts") && line?.includes("\u25cf") === true
    })

    expect(fixture.requests).toEqual([{ method: "POST", path: "/api/credential/cred_work/activate" }])
    expect(fixture.accounts.map((account) => account.id)).toEqual(["cred_work", "cred_personal"])
    const frame = fixture.app.captureCharFrame()
    expect(frame.indexOf("Personal")).toBeLessThan(frame.indexOf("Work"))
    expect(fixture.reads.integration).toBe(1)
    expect(fixture.reads.model).toBeGreaterThan(0)
    expect(fixture.reads.provider).toBeGreaterThan(0)
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("does not refetch when selecting the already-active account", async () => {
  const fixture = await renderIntegration()

  try {
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressEnter()

    expect(fixture.requests).toEqual([])
    expect(fixture.reads.model).toBe(0)
    expect(fixture.reads.provider).toBe(0)
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("renames the selected account through a prefilled prompt and reopens the account manager", async () => {
  const fixture = await renderIntegration()

  try {
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressKey("r", { ctrl: true })
    await fixture.app.waitFor(() => fixture.app.renderer.currentFocusedEditor instanceof TextareaRenderable)

    const textarea = fixture.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused rename prompt")
    expect(textarea.plainText).toBe("Work")

    await fixture.app.mockInput.typeText(" Account")
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitForFrame((frame) => frame.includes("Connected accounts") && frame.includes("Work Account"))

    expect(fixture.requests).toEqual([
      { method: "PATCH", path: "/api/credential/cred_work", body: { label: "Work Account" } },
    ])
    expect(fixture.accounts.find((account) => account.id === "cred_work")?.label).toBe("Work Account")
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("requires delete confirmation and preserves the account manager when another credential remains", async () => {
  const fixture = await renderIntegration()

  try {
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressKey("d", { ctrl: true })

    expect(fixture.requests).toEqual([])

    fixture.app.mockInput.pressKey("d", { ctrl: true })
    await fixture.app.waitForFrame((frame) => frame.includes("Connected accounts") && !frame.includes("Work"))

    expect(fixture.requests).toEqual([{ method: "DELETE", path: "/api/credential/cred_work" }])
    expect(fixture.accounts).toEqual([{ type: "credential", method: "key", id: "cred_personal", label: "Personal" }])
    expect(fixture.reads.model).toBe(0)
    expect(fixture.reads.provider).toBe(0)
    expect(fixture.app.captureCharFrame()).toContain("Add account")
    expect(fixture.app.captureCharFrame()).toContain("Personal")
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("renames the account label rather than its delete-confirmation message", async () => {
  const fixture = await renderIntegration()

  try {
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressKey("d", { ctrl: true })
    await fixture.app.waitForFrame((frame) => frame.includes("again to confirm"))

    fixture.app.mockInput.pressKey("r", { ctrl: true })
    await fixture.app.waitFor(() => fixture.app.renderer.currentFocusedEditor instanceof TextareaRenderable)

    const textarea = fixture.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused rename prompt")
    expect(textarea.plainText).toBe("Work")
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("marks the remaining account active after deleting the active credential", async () => {
  const fixture = await renderIntegration()

  try {
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressKey("d", { ctrl: true })
    fixture.app.mockInput.pressKey("d", { ctrl: true })

    await fixture.app.waitForFrame((frame) => {
      const line = frame.split("\n").find((entry) => entry.includes("Work"))
      return !frame.includes("Personal") && line?.includes("\u25cf") === true
    })

    expect(fixture.requests).toEqual([{ method: "DELETE", path: "/api/credential/cred_personal" }])
    expect(fixture.accounts).toEqual([{ type: "credential", method: "key", id: "cred_work", label: "Work" }])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("hides account rename and delete actions while the add account row is selected", async () => {
  const fixture = await renderIntegration()

  try {
    expect(fixture.app.captureCharFrame()).not.toContain("rename")
    expect(fixture.app.captureCharFrame()).not.toContain("delete")

    fixture.app.mockInput.pressKey("r", { ctrl: true })
    fixture.app.mockInput.pressKey("d", { ctrl: true })
    fixture.app.mockInput.pressKey("d", { ctrl: true })

    expect(fixture.requests).toEqual([])
    expect(fixture.app.renderer.currentFocusedEditor).toBeInstanceOf(InputRenderable)
    expect(fixture.app.captureCharFrame()).toContain("Connected accounts")

    fixture.app.mockInput.pressArrow("down")
    await fixture.app.waitForFrame((frame) => frame.includes("rename") && frame.includes("delete"))

    fixture.app.mockInput.pressArrow("up")
    await fixture.app.waitForFrame((frame) => !frame.includes("rename") && !frame.includes("delete"))
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("uses the active location for integration data without scoping credential requests", async () => {
  const location = { directory: "/remote/project" }
  const fixture = await renderIntegration(location)

  try {
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressEnter()

    await fixture.app.waitFor(() => fixture.requests.length === 1)
    expect(fixture.locations).toContainEqual(location)
    expect(fixture.locations.at(-1)).toEqual(location)
    expect(fixture.credentialQueries).toEqual([""])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("lists OpenCode Console above OpenCode Go, whose sign-in comes before an API key", async () => {
  const events = createEventStream()
  const oauth: unknown[] = []
  const calls = createFetch(async (url, request) => {
    const directory = process.cwd()
    const location = { directory, project: { id: "proj_test", directory, canonical: directory } }
    if (url.pathname === "/api/integration")
      return json({
        location,
        data: [
          {
            id: "opencode-go",
            name: "OpenCode Go",
            methods: [
              { type: "key", label: "Use an API key" },
              {
                type: "oauth",
                id: "device",
                integrationID: "opencode",
                label: "Sign in with your OpenCode account",
              },
            ],
            connections: [],
          },
          {
            id: "opencode",
            name: "OpenCode Console",
            methods: [{ type: "oauth", id: "device", label: "Sign in with your OpenCode account" }],
            connections: [],
          },
          { id: "anthropic", name: "Anthropic", methods: [{ type: "key", label: "API key" }], connections: [] },
        ],
      })
    if (url.pathname === "/api/integration/opencode-go/connect/oauth" && request.method === "POST") {
      oauth.push(await request.json())
      return json({
        location,
        data: {
          attemptID: "attempt_go",
          mode: "auto",
          url: "https://opencode.ai/console/device?user_code=ABCD-EFGH",
          instructions: "Enter code: ABCD-EFGH",
        },
      })
    }
    if (url.pathname === "/api/integration/opencode-go/connect/oauth/attempt_go") {
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      return json({ location, data: { status: "pending" } })
    }
    if (url.pathname === "/api/model" || url.pathname === "/api/provider") return json({ location, data: [] })
    return undefined
  }, events)

  function Probe() {
    const data = useData()
    const dialog = useDialog()
    onMount(() => void data.location.integration.sync().then(() => dialog.replace(() => <DialogIntegration />)))
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ToastProvider>
              <ClientProvider api={createApi(calls.fetch)}>
                <DataProvider directory={process.cwd()}>
                  <LocationProvider>
                    <ThemeProvider mode="dark" source={emptyThemeSource}>
                      <DialogProvider>
                        <Probe />
                      </DialogProvider>
                    </ThemeProvider>
                  </LocationProvider>
                </DataProvider>
              </ClientProvider>
            </ToastProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Anthropic"))
    const frame = app.captureCharFrame()
    expect(frame.indexOf("OpenCode Console")).toBeLessThan(frame.indexOf("OpenCode Go"))

    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Sign in with your OpenCode account"))
    const methods = app.captureCharFrame()
    expect(methods).toContain("Connect OpenCode Go")
    expect(methods.indexOf("Sign in with your OpenCode account")).toBeLessThan(methods.indexOf("Use an API key"))

    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("ABCD-EFGH"))
    expect(oauth).toEqual([{ methodID: "device" }])
  } finally {
    app.renderer.destroy()
  }
})

test("shows Using your Go API key on the Go row and hands Go back to the OpenCode account when the Go key is removed", async () => {
  const events = createEventStream()
  let hasGoKey = true
  const removed: string[] = []
  const calls = createFetch(async (url, request) => {
    const directory = process.cwd()
    const location = { directory, project: { id: "proj_test", directory, canonical: directory } }
    if (url.pathname === "/api/integration")
      return json({
        location,
        data: [
          {
            id: "opencode",
            name: "OpenCode Console",
            methods: [{ type: "oauth", id: "device", label: "Sign in with your OpenCode account" }],
            connections: [{ type: "credential", method: "oauth", id: "cred_alpha", label: "Alpha" }],
          },
          {
            id: "opencode-go",
            name: "OpenCode Go",
            methods: [
              {
                type: "oauth",
                id: "device",
                integrationID: "opencode",
                label: "Sign in with your OpenCode account",
              },
              { type: "key", label: "Use an API key" },
            ],
            connections: hasGoKey
              ? [{ type: "credential", method: "key", id: "cred_go", label: "Go key" }]
              : [{ type: "credential", method: "oauth", id: "cred_alpha", label: "Alpha" }],
          },
        ],
      })
    if (url.pathname === "/api/credential/cred_go" && request.method === "DELETE") {
      removed.push("cred_go")
      hasGoKey = false
      events.emit({ id: "evt_deleted_go", created: Date.now(), type: "credential.updated", data: {} })
      events.emit({
        id: "evt_switched_go",
        created: Date.now(),
        type: "credential.switched",
        data: { integrationID: "opencode-go", credentialID: "cred_alpha" },
      })
      return new Response(null, { status: 204 })
    }
    if (url.pathname === "/api/model" || url.pathname === "/api/provider") return json({ location, data: [] })
    return undefined
  }, events)

  function Probe() {
    const data = useData()
    const dialog = useDialog()
    onMount(() => void data.location.integration.sync().then(() => dialog.replace(() => <DialogIntegration />)))
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ToastProvider>
              <ClientProvider api={createApi(calls.fetch)}>
                <DataProvider directory={process.cwd()}>
                  <LocationProvider>
                    <ThemeProvider mode="dark" source={emptyThemeSource}>
                      <DialogProvider>
                        <Probe />
                      </DialogProvider>
                    </ThemeProvider>
                  </LocationProvider>
                </DataProvider>
              </ClientProvider>
            </ToastProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Using your Go API key"))
    expect(app.captureCharFrame()).toContain("Using your Go API key")

    // Open OpenCode Go -> move to Go key -> delete (ctrl+d twice) -> hands back to OpenCode account.
    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Connected accounts"))
    app.mockInput.pressArrow("down")
    app.mockInput.pressKey("d", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("again to confirm"))
    app.mockInput.pressKey("d", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("Using your OpenCode account") && frame.includes("Alpha"))
    expect(removed).toEqual(["cred_go"])
  } finally {
    app.renderer.destroy()
  }
})

async function renderIntegration(activeLocation?: LocationRef, form?: FormFields) {
  const events = createEventStream()
  const requests: Array<{ method: string; path: string; body?: unknown }> = []
  const locations: LocationRef[] = []
  const credentialQueries: string[] = []
  const reads = { integration: 0, model: 0, provider: 0 }
  let accounts = [
    { type: "credential" as const, method: "key" as const, id: "cred_personal", label: "Personal" },
    { type: "credential" as const, method: "key" as const, id: "cred_work", label: "Work" },
  ]

  const calls = createFetch(async (url, request) => {
    const directory =
      url.searchParams.get("location[directory]") ??
      decodeURIComponent(request.headers.get("x-opencode-directory") ?? process.cwd())
    const requestedLocation = { directory }
    const location = {
      ...requestedLocation,
      project: { id: "proj_test", directory, canonical: directory },
    }

    if (url.pathname === "/api/integration") {
      locations.push(requestedLocation)
      reads.integration++
      return json({
        location,
        data: [
          {
            id: "openai",
            name: "OpenAI",
            methods: [{ type: "key", label: "API key", form }],
            connections: [...accounts, { type: "env", name: "OPENAI_API_KEY" }],
          },
        ],
      })
    }

    if (request.method === "POST" && url.pathname === "/api/integration/openai/connect/key") {
      requests.push({ method: request.method, path: url.pathname, body: await request.json() })
      return new Response(null, { status: 204 })
    }

    if (url.pathname === "/api/model") {
      reads.model++
      return json({ location, data: [] })
    }

    if (url.pathname === "/api/provider") {
      reads.provider++
      return json({ location, data: [] })
    }

    if (request.method === "POST" && /^\/api\/credential\/[^/]+\/activate$/.test(url.pathname)) {
      credentialQueries.push(url.search)
      const id = url.pathname.split("/")[3]
      const active = accounts.find((account) => account.id === id)
      if (!active) throw new Error(`unknown credential: ${id}`)
      accounts = [active, ...accounts.filter((account) => account.id !== id)]
      requests.push({ method: request.method, path: url.pathname })
      events.emit({
        id: `evt_switched_${id}`,
        created: Date.now(),
        type: "credential.switched",
        data: { integrationID: "openai", credentialID: id },
      })
      return new Response(null, { status: 204 })
    }

    if (request.method === "PATCH" && /^\/api\/credential\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3]
      const body = (await request.json()) as { label: string }
      accounts = accounts.map((account) => (account.id === id ? { ...account, label: body.label } : account))
      requests.push({ method: request.method, path: url.pathname, body })
      events.emit({ id: `evt_updated_${id}`, created: Date.now(), type: "credential.updated", data: {} })
      return new Response(null, { status: 204 })
    }

    if (request.method === "DELETE" && /^\/api\/credential\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3]
      const active = accounts[0]?.id === id
      accounts = accounts.filter((account) => account.id !== id)
      requests.push({ method: request.method, path: url.pathname })
      events.emit({ id: `evt_deleted_${id}`, created: Date.now(), type: "credential.updated", data: {} })
      if (active)
        events.emit({
          id: `evt_switched_${id}`,
          created: Date.now(),
          type: "credential.switched",
          data: { integrationID: "openai", credentialID: accounts[0]?.id ?? null },
        })
      return new Response(null, { status: 204 })
    }

    return undefined
  }, events)

  function Probe() {
    const data = useData()
    const dialog = useDialog()
    const location = useLocation()
    onMount(() => {
      location.set(activeLocation)
      void data.location.integration
        .sync(activeLocation)
        .then(() => dialog.replace(() => <DialogIntegration integrationID="openai" autoConnect />))
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ToastProvider>
              <ClientProvider api={createApi(calls.fetch)}>
                <DataProvider directory={process.cwd()}>
                  <LocationProvider>
                    <ThemeProvider mode="dark" source={emptyThemeSource}>
                      <DialogProvider>
                        <Probe />
                      </DialogProvider>
                    </ThemeProvider>
                  </LocationProvider>
                </DataProvider>
              </ClientProvider>
            </ToastProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )

  app.renderer.start()
  await app.waitForFrame(
    (frame) => frame.includes("Add account") && frame.includes("Personal") && frame.includes("Work"),
  )
  await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)

  return {
    app,
    reads,
    requests,
    locations,
    credentialQueries,
    get accounts() {
      return accounts
    },
  }
}

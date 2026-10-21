import { expect, test, type Page } from "@playwright/test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { once } from "node:events"
import { extname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { build } from "vite"
import { serviceWorker } from "../../vite.pwa"

type Site = {
  url: string
  session: number
  rejectApi: boolean
  apiAuth: "redirect" | "unauthorized" | "native"
  apiStatus?: 403
  probeStatus?: 200 | 401
}

const fixture = test.extend<{ site: Site }, { dist: string }>({
  dist: [
    async ({}, use) => {
      const root = await mkdtemp(join(tmpdir(), "opencode-sign-in-proxy-"))
      try {
        await writeFile(
          join(root, "index.html"),
          `<h1>App</h1><output></output><script type="module" src="/main.js"></script>`,
        )
        await writeFile(
          join(root, "main.js"),
          `import { fetchThroughSignInProxy } from "sign-in-proxy"
        window.proxyFetch = fetchThroughSignInProxy
        const probes = []
        const nativeFetch = window.fetch
        window.fetch = (input, init) => {
          const pending = nativeFetch(input, init)
          if (input === "/api/info") probes.push(pending.catch(() => {}))
          return pending
        }
        // Resolves after every sign-in check has settled; the app's handler for each check runs first.
        window.probes = () => Promise.all(probes).then(() => probes.length)
        navigation.addEventListener("navigate", () => (document.querySelector("h1").textContent = "Leaving"))
        fetchThroughSignInProxy("/api/session", { headers: { Accept: "application/json" } })
          .then((response) => response.json(), () => "failed")
          .then((text) => (document.querySelector("output").textContent = text))`,
        )
        await build({
          configFile: false,
          root,
          logLevel: "silent",
          resolve: {
            alias: {
              "sign-in-proxy": fileURLToPath(new URL("../../src/runtime/platform/sign-in-proxy.ts", import.meta.url)),
            },
          },
          build: { outDir: "dist", assetsDir: "_assets" },
          plugins: serviceWorker(join(root, "dist")),
        })
        await use(join(root, "dist"))
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    { scope: "worker" },
  ],
  site: async ({ dist }, use) => {
    // Models Dev Tunnels: every path needs a cookie, sign-in happens on another origin (localhost instead of
    // 127.0.0.1), and it returns through /auth/postback, which sets the cookie and redirects to rd.
    const site: Site = { url: "", session: 1, rejectApi: false, apiAuth: "redirect" }
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`)
      const rd = encodeURIComponent(url.searchParams.get("rd") ?? url.pathname + url.search)
      if (url.hostname === "localhost")
        return void response
          .writeHead(200, { "content-type": "text/html" })
          .end(`<a href="${site.url}/auth/postback?rd=${rd}">Sign in</a>`)
      if (url.pathname === "/auth/postback")
        return void response
          .writeHead(302, {
            location: url.searchParams.get("rd") ?? "/",
            "set-cookie": `session=${site.session}; Path=/`,
          })
          .end()
      const api = url.pathname.startsWith("/api/")
      if (url.pathname === "/api/info" && site.probeStatus)
        return void response.writeHead(site.probeStatus, { "content-type": "application/json" }).end("{}")
      if (request.headers.cookie !== `session=${site.session}` || (api && site.rejectApi)) {
        if (api && site.apiAuth === "native")
          return void response.writeHead(401, { "content-type": "application/json" }).end(`"unauthorized"`)
        const location = `${site.url.replace("127.0.0.1", "localhost")}/?rd=${rd}`
        if (api && site.apiAuth === "unauthorized" && request.headers.accept?.includes("application/json")) {
          const status = site.apiStatus ?? 401
          return void response
            .writeHead(status, { location, "content-type": "application/json" })
            .end(JSON.stringify(`proxy-${status}`))
        }
        return void response.writeHead(302, { location }).end()
      }
      if (api) return void response.writeHead(200, { "content-type": "application/json" }).end(`"signed in"`)
      const file = await readFile(join(dist, extname(url.pathname) ? url.pathname : "index.html")).catch(
        () => undefined,
      )
      if (!file) return void response.writeHead(404).end()
      response
        .writeHead(200, { "content-type": url.pathname.endsWith(".js") ? "text/javascript" : "text/html" })
        .end(file)
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    site.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await use(site)
    server.closeAllConnections()
    server.close()
  },
})

async function signIn(page: Page) {
  await page.getByRole("link", { name: "Sign in" }).click()
}

async function install(page: Page, site: Site) {
  await page.goto(site.url)
  await signIn(page)
  await expect(page).toHaveURL(`${site.url}/`)
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js")
    await navigator.serviceWorker.ready
  })
  await page.reload()
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe("activated")
  await expect(page.getByRole("status")).toHaveText("signed in")
}

function probes(page: Page) {
  return page.evaluate<number>("window.probes()")
}

for (const apiAuth of ["redirect", "unauthorized"] as const) {
  fixture(
    `sends the cached app through sign-in when the proxy session expires (${apiAuth})`,
    async ({ page, site }) => {
      site.apiAuth = apiAuth
      await install(page, site)
      site.session++
      await page.goto(`${site.url}/workspace`)
      await signIn(page)
      await expect(page).toHaveURL(`${site.url}/workspace?reauth=1`)
      await expect(page.getByRole("status")).toHaveText("signed in")
    },
  )

  fixture(`tries once while the proxy keeps rejecting API requests (${apiAuth})`, async ({ page, site }) => {
    site.apiAuth = apiAuth
    await install(page, site)
    site.session++
    site.rejectApi = true
    await page.goto(`${site.url}/workspace`)
    await signIn(page)
    await expect(page).toHaveURL(`${site.url}/workspace?reauth=1`)
    await expect(page.getByRole("status")).toHaveText(apiAuth === "unauthorized" ? "proxy-401" : "failed")
    expect(await probes(page)).toBe(0)
    await expect(page.getByRole("heading")).toHaveText("App")
  })
}

for (const probeStatus of [200, 401] as const) {
  fixture(`stays on the app when the sign-in probe answers ${probeStatus}`, async ({ page, site }) => {
    await install(page, site)
    site.apiAuth = "unauthorized"
    site.rejectApi = true
    site.probeStatus = probeStatus
    await page.goto(`${site.url}/workspace`)
    await expect(page.getByRole("status")).toHaveText("proxy-401")
    expect(await probes(page)).toBe(1)
    await expect(page).toHaveURL(`${site.url}/workspace`)
    await expect(page.getByRole("heading")).toHaveText("App")
  })
}

fixture("leaves forbidden responses with Location on the app", async ({ page, site }) => {
  await install(page, site)
  site.apiAuth = "unauthorized"
  site.apiStatus = 403
  site.rejectApi = true
  await page.goto(`${site.url}/workspace`)
  await expect(page.getByRole("status")).toHaveText("proxy-403")
  expect(await probes(page)).toBe(0)
  await expect(page).toHaveURL(`${site.url}/workspace`)
  await expect(page.getByRole("heading")).toHaveText("App")
})

fixture("leaves native unauthorized responses on the app", async ({ page, site }) => {
  await install(page, site)
  site.apiAuth = "native"
  site.rejectApi = true
  await page.goto(`${site.url}/workspace`)
  await expect(page.getByRole("status")).toHaveText("unauthorized")
  expect(await probes(page)).toBe(0)
  await expect(page).toHaveURL(`${site.url}/workspace`)
  await expect(page.getByRole("heading")).toHaveText("App")
})

fixture("ignores cross-origin unauthorized responses with Location", async ({ page, site }) => {
  await install(page, site)
  site.session++
  const url = `${site.url.replace("127.0.0.1", "localhost")}/api/session`
  await page.route(url, (route) =>
    route.fulfill({
      status: 401,
      headers: {
        "access-control-allow-origin": site.url,
        "access-control-expose-headers": "Location",
        location: "https://login.example/",
      },
      json: "proxy-401",
    }),
  )
  expect(
    await page.evaluate(
      `window.proxyFetch(${JSON.stringify(url)}).then(r => ({ status: r.status, location: r.headers.get("location") }))`,
    ),
  ).toEqual({ status: 401, location: "https://login.example/" })
  expect(await probes(page)).toBe(0)
  await expect(page).toHaveURL(`${site.url}/`)
  await expect(page.getByRole("heading")).toHaveText("App")
})

fixture("does not reauthenticate an aborted request", async ({ page, site }) => {
  await install(page, site)
  site.session++
  expect(
    await page.evaluate(`(() => {
      const controller = new AbortController()
      controller.abort()
      return window.proxyFetch("/api/session", { signal: controller.signal })
        .then(() => "completed", error => error.name)
    })()`),
  ).toBe("AbortError")
  expect(await probes(page)).toBe(0)
  await expect(page).toHaveURL(`${site.url}/`)
  await expect(page.getByRole("heading")).toHaveText("App")
})

fixture("can recover another expiry after a successful request rearms it", async ({ page, site }) => {
  site.apiAuth = "unauthorized"
  await install(page, site)
  site.session++
  site.rejectApi = true
  await page.goto(`${site.url}/workspace`)
  await signIn(page)
  await expect(page.getByRole("status")).toHaveText("proxy-401")
  expect(await probes(page)).toBe(0)
  site.rejectApi = false
  expect(await page.evaluate(`window.proxyFetch("/api/session").then(r => r.status)`)).toBe(200)
  site.session++
  await page.evaluate(`void window.proxyFetch("/api/session", { headers: { Accept: "application/json" } })`)
  await signIn(page)
  await expect(page).toHaveURL(`${site.url}/workspace?reauth=1`)
  await expect(page.getByRole("status")).toHaveText("signed in")
})

fixture("stays on the cached app when the network is down", async ({ page, context, site }) => {
  await install(page, site)
  await context.setOffline(true)
  await page.goto(`${site.url}/workspace`)
  await expect(page.getByRole("status")).toHaveText("failed")
  expect(await probes(page)).toBe(1)
  await expect(page.getByRole("heading")).toHaveText("App")
})

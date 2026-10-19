import { afterEach, expect, jest, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, settleMs, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent } from "../src/promise"

afterEach(() => jest.useRealTimers())

const catalogs = ["integration", "model", "provider"] as const

test.each(catalogs)("%s notifications leave unopened locations unloaded until first use", async (field) => {
  jest.useFakeTimers()
  const setup = fixture()
  const opened = { directory: "/project" }
  const unopened = { directory: "/other" }
  try {
    await Promise.all(catalogs.map((field) => setup.data.location[field].sync(opened)))
    setup.requests.length = 0
    // An unrelated event can create a store entry without the client opening it.
    setup.emit({ type: "vcs.branch.updated", location: unopened, data: { branch: "dev" } })
    setup.emit({ type: `${field}.updated`, location: unopened, data: {} })
    setup.emit({ type: `${field}.updated`, location: { ...opened, workspaceID: "other" }, data: {} })
    jest.runOnlyPendingTimers()
    expect(setup.requests).toEqual([])
    catalogs.forEach((field) => expect(setup.data.location[field].list(unopened)).toBeUndefined())

    await Promise.all(catalogs.map((field) => setup.data.location[field].sync(unopened)))
    expect(setup.requests).toEqual(catalogs.map((field) => [`/api/${field}`, unopened.directory]))
    catalogs.forEach((field) => expect(setup.data.location[field].list(unopened)).toEqual([]))
  } finally {
    setup.dispose()
  }
})

test.each(catalogs)("%s notifications refresh loaded catalogs only at their location", async (field) => {
  jest.useFakeTimers()
  const setup = fixture()
  const location = { directory: "/project" }
  try {
    await Promise.all(
      [location, { directory: "/other" }].flatMap((location) =>
        catalogs.map((field) => setup.data.location[field].sync(location)),
      ),
    )
    setup.requests.length = 0
    setup.emit({ type: `${field}.updated`, location, data: {} })
    expect(setup.requests).toEqual([])
    jest.runOnlyPendingTimers()
    expect(setup.requests).toEqual(
      (field === "integration" ? catalogs : [field]).map((field) => [`/api/${field}`, location.directory]),
    )
    await Promise.all(catalogs.map((field) => setup.data.location[field].sync(location)))
  } finally {
    setup.dispose()
  }
})

test("related catalog notifications coalesce to one read per loaded catalog", async () => {
  jest.useFakeTimers()
  const setup = fixture()
  const location = { directory: "/project" }
  try {
    await Promise.all(catalogs.map((field) => setup.data.location[field].sync(location)))
    setup.requests.length = 0
    setup.emit({ type: "integration.updated", location, data: {} })
    jest.advanceTimersByTime(settleMs / 2)
    setup.emit({ type: "model.updated", location, data: {} })
    setup.emit({ type: "provider.updated", location, data: {} })
    setup.emit({ type: "integration.updated", location, data: {} })
    expect(setup.requests).toEqual([])
    jest.runOnlyPendingTimers()
    expect(setup.requests).toEqual(catalogs.map((field) => [`/api/${field}`, location.directory]))
    await Promise.all(catalogs.map((field) => setup.data.location[field].sync(location)))
    expect(setup.requests).toHaveLength(3)
  } finally {
    setup.dispose()
  }
})

function fixture() {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const requests: string[][] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const url = new URL((input instanceof Request ? input : new Request(input, init)).url)
      const directory = url.searchParams.get("location[directory]") ?? "/project"
      requests.push([url.pathname, directory])
      return Response.json({ location: { directory }, data: [] })
    },
  })
  return createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    emit: (details: OpenCodeEvent) => listeners.forEach((listener) => listener({ name: details.type, details })),
    requests,
    dispose,
  }))
}

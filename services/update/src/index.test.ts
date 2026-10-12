import { describe, expect, test } from "bun:test"
import worker, { channelsForRef, validGitHubClaims } from "./index"

const claims = (ref: string) => ({
  repository: "anomalyco/opencode",
  repository_id: "975734319",
  repository_owner_id: "66570915",
  workflow_ref: `anomalyco/opencode/.github/workflows/publish.yml@${ref}`,
  ref,
  sha: "sha",
  run_id: "1",
  run_attempt: "1",
  actor: "opencode",
})

describe("channelsForRef", () => {
  test("OpenCode 1 publishes only to the v1 channel", () => {
    expect(channelsForRef("refs/heads/v1")).toEqual(["v1"])
  })

  test("OpenCode 2 refs never publish to the v1 channel", () => {
    for (const ref of [
      "refs/heads/dev",
      "refs/heads/v2",
      "refs/heads/beta",
      "refs/heads/ci",
      "refs/heads/snapshot-v1",
    ]) {
      expect(channelsForRef(ref)).not.toContain("v1")
    }
  })

  test("unknown refs publish nowhere", () => {
    expect(channelsForRef("refs/heads/v1-hotfix")).toEqual([])
    expect(channelsForRef("refs/tags/v1.19.0")).toEqual([])
  })
})

describe("validGitHubClaims", () => {
  test("accepts the v1 publish workflow", () => {
    expect(validGitHubClaims(claims("refs/heads/v1"))).toBe(true)
  })

  test("rejects a workflow from another ref", () => {
    expect(validGitHubClaims({ ...claims("refs/heads/v1"), workflow_ref: claims("refs/heads/dev").workflow_ref })).toBe(
      false,
    )
  })
})

const rows = [
  { channel: "latest", name: "cli", distribution: "github", version: "2.0.27" },
  { channel: "v1", name: "cli", distribution: "github", version: "1.19.0" },
].map((row) => ({ ...row, metadata: "{}", active: 1, minimum: 0, time_created: 0, time_updated: 0 }))

// Answers the artifact lookups the public API makes, keyed by their bound parameters.
const db = {
  prepare: () => ({
    bind: (...params: unknown[]) => ({
      first: async () => null,
      all: async () => ({
        results: rows.filter((row) =>
          [row.channel, row.name, row.distribution].every((v, i) => params[i] === undefined || params[i] === v),
        ),
      }),
    }),
  }),
}

const request = (path: string) =>
  worker.fetch(
    new Request(`https://opencode.ai/update${path}`, { headers: { "User-Agent": "opencode/latest/1.18.0/cli" } }),
    { DB: db as unknown as D1Database, EVENTS: { send: async () => {} } as never },
    { waitUntil: () => {} },
  )

describe("v1 channel", () => {
  test("serves OpenCode 1 releases to OpenCode 1 clients", async () => {
    const response = await request("/api/v1/cli/github")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ channel: "v1", version: "1.19.0" })
  })

  test("is separate from the OpenCode 2 latest channel", async () => {
    const response = await request("/api/latest/cli/github")
    expect(await response.json()).toMatchObject({ channel: "latest", version: "2.0.27" })
  })
})

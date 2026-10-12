#!/usr/bin/env bun

import { $ } from "bun"

// OpenCode 1 clients, its installer, desktop updater, and GitHub Action resolve updates through GitHub's
// Latest release. Until the V1 → V2 flip, Latest must stay on a 1.x release.
const repo = process.env["GH_REPO"] || "anomalyco/opencode"
const latest = (await $`gh api repos/${repo}/releases/latest --jq .tag_name`.text()).trim()

if (/^v1\./.test(latest)) {
  console.log(`GitHub Latest release for ${repo} is ${latest}`)
  process.exit(0)
}

const v1 = (
  await $`gh api repos/${repo}/releases --paginate --jq ${".[] | select(.draft | not) | select(.prerelease | not) | .tag_name"}`.text()
)
  .split("\n")
  .filter((tag) => /^v1\.\d+\.\d+$/.test(tag))
  .sort((a, b) => Bun.semver.order(b.slice(1), a.slice(1)))[0]

console.error(`::error::GitHub Latest release for ${repo} is ${latest}, but it must stay on a v1.x release.`)
console.error("OpenCode 1 clients would offer this release as a normal update. Restore the newest V1 release:")
console.error(`  gh release edit ${v1 ?? "<newest v1.x tag>"} --repo ${repo} --latest`)
process.exit(1)

#!/usr/bin/env bun

// Waits until another job of this workflow run uploads an artifact, so a job can do its other work while that job
// runs. Fails as soon as the producing job ends without the artifact.
// Usage: bun script/wait-for-artifact.ts <artifact name> <producing job name>

const [artifact, producer] = process.argv.slice(2)

if (!artifact || !producer) throw new Error("Usage: bun script/wait-for-artifact.ts <artifact> <job>")

const token = process.env.GITHUB_TOKEN

if (!token) throw new Error("GITHUB_TOKEN is required")

const run = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
const started = Date.now()

while (Date.now() - started < 30 * 60_000) {
  if (await uploaded()) {
    console.log(`${artifact} is ready after ${Math.round((Date.now() - started) / 1000)}s`)
    process.exit(0)
  }

  const conclusion = await producerConclusion()

  if (conclusion && conclusion !== "success") throw new Error(`${producer} finished with ${conclusion}`)
  // A job can finish just before its artifact appears in the listing.
  if (conclusion === "success" && (await uploaded())) process.exit(0)
  if (conclusion === "success") throw new Error(`${producer} succeeded without uploading ${artifact}`)

  await Bun.sleep(5_000)
}

throw new Error(`Timed out waiting for ${artifact}`)

async function uploaded() {
  const body = await get(`${run}/artifacts?name=${encodeURIComponent(artifact)}`)

  return isRecord(body) && typeof body.total_count === "number" && body.total_count > 0
}

async function producerConclusion() {
  const body = await get(`${run}/attempts/${process.env.GITHUB_RUN_ATTEMPT ?? "1"}/jobs?per_page=100`)
  const jobs = isRecord(body) && Array.isArray(body.jobs) ? body.jobs : []
  // A matrix job whose needs failed is never expanded: it completes as skipped under its bare name, e.g. "build-cli".
  const names = [producer, producer.replace(/ \(.*\)$/, "")]
  const job = jobs.find((item) => isRecord(item) && typeof item.name === "string" && names.includes(item.name))

  if (!isRecord(job) || job.status !== "completed") return undefined

  return typeof job.conclusion === "string" ? job.conclusion : "unknown"
}

// A failed request reads as "not ready yet": a transient API error must not fail the job, only the deadline or the
// producer's conclusion does.
async function get(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  }).catch((error: unknown) => {
    console.warn(`GitHub API request failed for ${url}: ${error}`)
    return undefined
  })

  if (!response) return undefined

  if (!response.ok) {
    console.warn(`GitHub API ${response.status} for ${url}`)
    return undefined
  }

  return response.json().catch(() => undefined)
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

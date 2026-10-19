#!/usr/bin/env bun

// Waits until another job of this workflow run uploads an artifact, so a job can do its other work while that job
// runs. Fails as soon as the producing job ends without the artifact.
// Usage: bun script/wait-for-artifact.ts <artifact name> <producing job name> [<job the producer needs>...]

const [artifact, producer, ...upstream] = process.argv.slice(2)

if (!artifact || !producer) throw new Error("Usage: bun script/wait-for-artifact.ts <artifact> <job> [<needed job>...]")

const token = process.env.GITHUB_TOKEN

if (!token) throw new Error("GITHUB_TOKEN is required")

const run = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
// A matrix job whose needs failed is never expanded: it completes as skipped under its bare name, e.g. "build-cli".
const producers = [producer, producer.replace(/ \(.*\)$/, "")]
const wait = 30 * 60_000
const started = Date.now()
// Queue time counts against the deadline; it moves forward while the producer, or a job it needs, is running.
let deadline = started + wait
let failures = 0

for (let check = 0; Date.now() < deadline; check++) {
  if (await uploaded()) ready()

  const jobs = check % 3 === 0 ? await listJobs() : []
  const job = jobs.find((item) => producers.includes(item.name))

  if (job?.status === "completed" && job.conclusion !== "success") {
    throw new Error(`${job.name} finished with ${job.conclusion}`)
  }
  if (job?.status === "completed" && (await confirmed())) ready()
  if (jobs.some((item) => item.status === "in_progress" && [...producers, ...upstream].includes(item.name))) {
    deadline = Date.now() + wait
  }

  // Requests spend the repository's GITHUB_TOKEN budget (1,000 an hour, shared with other workflows). This pace costs a
  // waiting job about 107 requests in its first hour and 80 an hour after.
  await Bun.sleep(Date.now() - started < 10 * 60_000 ? 20_000 : 60_000)
}

throw new Error(`Timed out waiting for ${artifact}`)

function ready(): never {
  console.log(`${artifact} is ready after ${Math.round((Date.now() - started) / 1000)}s`)
  process.exit(0)
}

// Undefined when the request failed.
async function uploaded() {
  const body = await get(`${run}/artifacts?name=${encodeURIComponent(artifact)}`)

  if (!isRecord(body) || typeof body.total_count !== "number") return undefined

  return body.total_count > 0
}

// A job can finish just before its artifact is listed. Only a definite "not uploaded" on the last check fails.
async function confirmed() {
  for (const attempt of [1, 2, 3]) {
    await Bun.sleep(5_000)
    const found = await uploaded()

    if (found) return true
    if (found === false && attempt === 3) throw new Error(`${producer} succeeded without uploading ${artifact}`)
  }

  return false
}

// Jobs appear in this listing only once their own needs have finished.
async function listJobs() {
  const body = await get(`${run}/attempts/${process.env.GITHUB_RUN_ATTEMPT ?? "1"}/jobs?per_page=100`)
  const jobs = isRecord(body) && Array.isArray(body.jobs) ? body.jobs : []

  return jobs
    .filter(isRecord)
    .flatMap((job) =>
      typeof job.name === "string" ? [{ name: job.name, status: job.status, conclusion: job.conclusion }] : [],
    )
}

// Retries rate limits, 5xx responses and network errors; fails at once on errors a retry cannot fix (401, 404,
// missing permission).
async function get(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  }).catch((error: unknown) => {
    console.warn(`GitHub API request failed for ${url}: ${error}`)
    return undefined
  })

  if (response?.ok) {
    failures = 0
    return response.json().catch(() => undefined)
  }

  const text = (await response?.text().catch(() => "")) ?? ""
  const limited =
    response?.status === 429 ||
    (response?.status === 403 &&
      (response.headers.has("retry-after") ||
        response.headers.get("x-ratelimit-remaining") === "0" ||
        /rate limit/i.test(text)))

  if (response && response.status < 500 && !limited) {
    throw new Error(`GitHub API ${response.status} for ${url}: ${text}`)
  }

  const delay = backoff(response, limited)

  // Waiting out a rate limit does not spend the deadline.
  if (limited) deadline += delay

  console.warn(
    `GitHub API ${response?.status ?? "request failed"} for ${url}; retrying in ${Math.round(delay / 1000)}s`,
  )
  await Bun.sleep(delay)

  // Retry at once, so a wait ending just before the deadline still gets its request in.
  return Date.now() < deadline ? get(url) : undefined
}

// GitHub's guidance: retry-after, then x-ratelimit-reset, otherwise at least a minute, doubling while it persists.
function backoff(response: Response | undefined, limited: boolean) {
  failures++
  const retryAfter = Number(response?.headers.get("retry-after"))

  if (retryAfter > 0) return retryAfter * 1000

  const reset = Number(response?.headers.get("x-ratelimit-reset"))

  if (response?.headers.get("x-ratelimit-remaining") === "0" && reset > 0) {
    return Math.max(0, reset * 1000 - Date.now()) + 1000
  }

  if (limited) return Math.min(10 * 60_000, 60_000 * 2 ** (failures - 1))

  return Math.min(60_000, 5_000 * 2 ** failures)
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

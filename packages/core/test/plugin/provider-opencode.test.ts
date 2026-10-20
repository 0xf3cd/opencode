import { describe, expect } from "bun:test"
import { LLM } from "@opencode/ai"
import { LLMClient, RequestExecutor } from "@opencode/ai/route"
import { ConfigPolicy } from "@opencode/schema/config/policy"
import { Document, Info as ConfigInfo } from "@opencode/schema/config"
import { Money } from "@opencode/schema/money"
import { Effect, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Agent } from "@opencode/core/agent"
import { App } from "@opencode/core/app"
import { Config } from "@opencode/core/config"
import { ConfigPolicyPlugin } from "@opencode/core/config/plugin/policy"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { ManagedPolicy } from "@opencode/core/managed-policy"
import { Mcp } from "@opencode/core/mcp/index"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { OpencodePlugin } from "@opencode/core/plugin/provider/opencode"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { WebSearch } from "@opencode/core/websearch"
import { withEnv } from "../fixture/env"
import { emptyMcp } from "../fixture/mcp"
import { drain } from "../lib/clock"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* OpencodePlugin.effect(host)
})

const noRemoteConfig = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))),
)

// Periodic Console checks run on TestClock, but a loopback request takes real time that `drain` does not wait for.
// Calling the server's handler in-process keeps each check within `drain`.
const inProcess = (server: { fetch: (request: Request) => Response | Promise<Response> }) =>
  Effect.provideService(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      HttpClientRequest.toWeb(request).pipe(
        Effect.orDie,
        Effect.flatMap((web) => Effect.promise(async () => server.fetch(web))),
        Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
      ),
    ),
  )

function consoleServer(orgID: string | null | undefined, unavailable = false) {
  const config: { authorization: string | null; orgID: string | null }[] = []
  const requests: string[] = []
  const agents: (string | null)[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      requests.push(path)
      agents.push(request.headers.get("user-agent"))
      if (path === "/auth/device/code") {
        expect(await request.json()).toEqual({ client_id: "opencode-cli", supports_org_scope: true })
        return Response.json({
          device_code: "device",
          user_code: "user",
          verification_uri_complete: "/device?user_code=user",
          expires_in: 60,
          interval: 0,
        })
      }
      if (path === "/auth/device/token") {
        return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 600, org_id: orgID })
      }
      if (unavailable && (path === "/api/user" || path === "/api/orgs")) {
        return new Response("Unavailable", { status: 503 })
      }
      if (path === "/api/user") return Response.json({ id: "user", email: "user@example.com" })
      if (path === "/api/orgs") {
        return Response.json([
          { id: "org-z", name: "Zebra" },
          { id: "org-a", name: "Alpha" },
        ])
      }
      if (path === "/api/v2/config") {
        config.push({ authorization: request.headers.get("authorization"), orgID: request.headers.get("x-org-id") })
        if (orgID === "org-missing") return new Response("Forbidden", { status: 403 })
        return Response.json({ providers: {} })
      }
      return new Response("Not found", { status: 404 })
    },
  })
  return { server, config, requests, agents }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function eventually<A, E>(
  effect: Effect.Effect<A, E>,
  predicate: (value: A) => boolean,
  remaining = 1000,
): Effect.Effect<A, E | Error> {
  return Effect.gen(function* () {
    const value = yield* effect
    if (predicate(value)) return value
    if (remaining === 0) return yield* Effect.fail(new Error("Timed out waiting for value"))
    yield* Effect.promise(() => Bun.sleep(1))
    return yield* eventually(effect, predicate, remaining - 1)
  })
}

const cost = (input: number, output = 0) => [
  {
    input: Money.USDPerMillionTokens.make(input),
    output: Money.USDPerMillionTokens.make(output),
    cache: {
      read: Money.USDPerMillionTokens.zero,
      write: Money.USDPerMillionTokens.zero,
    },
  },
]

describe("OpencodePlugin", () => {
  it.effect("registers account and service account methods", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      // Mirror ModelsDevPlugin registering `key` and `env` before OpencodePlugin runs.
      for (const id of [Integration.ID.make("opencode"), Integration.ID.make("opencode-go")]) {
        yield* integrations.transform((editor) => {
          editor.method.update({ integrationID: id, method: { type: "key" } })
          editor.method.update({ integrationID: id, method: { type: "env", names: ["OPENCODE_API_KEY"] } })
        })
      }
      yield* addPlugin()
      expect((yield* integrations.get(Integration.ID.make("opencode")))?.methods).toEqual([
        { type: "env", names: ["OPENCODE_API_KEY"] },
        {
          id: Integration.MethodID.make("device"),
          type: "oauth",
          label: "Sign in with your OpenCode account",
          form: [
            { key: "server", type: "string", format: "uri", hidden: true, default: "https://opencode.ai/console" },
          ],
        },
        { type: "key", label: "API key (service account)" },
      ])
      expect((yield* integrations.get(Integration.ID.make("opencode-go")))?.methods).toEqual([
        { type: "env", names: ["OPENCODE_API_KEY"] },
        {
          id: Integration.MethodID.make("device"),
          type: "oauth",
          label: "Sign in with your OpenCode account",
          integrationID: Integration.ID.make("opencode"),
          form: [
            { key: "server", type: "string", format: "uri", hidden: true, default: "https://opencode.ai/console" },
          ],
        },
        { type: "key", label: "Use an API key" },
      ])
    }),
  )

  it.live("uses a canonical custom server throughout device authorization", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const requests: string[] = []
        const server = Bun.serve({
          port: 0,
          fetch: (request) => {
            const url = new URL(request.url)
            requests.push(`${request.method} ${url.pathname}`)
            if (url.pathname.endsWith("/auth/device/code")) {
              return Response.json({
                device_code: "device",
                user_code: "user",
                verification_uri_complete: "/console/device?user_code=user&client_id=opencode-cli",
                expires_in: 60,
                interval: 0,
              })
            }
            if (url.pathname.endsWith("/auth/device/token")) {
              return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 600 })
            }
            if (url.pathname.endsWith("/api/user")) return Response.json({ id: "user", email: "user@example.com" })
            if (url.pathname.endsWith("/api/orgs")) return Response.json([{ id: "org", name: "Org" }])
            return new Response("Not found", { status: 404 })
          },
        })
        return { requests, server }
      }),
      ({ requests, server }) =>
        Effect.gen(function* () {
          yield* addPlugin()
          const integrations = yield* Integration.Service
          const integrationID = Integration.ID.make("opencode")
          const attempt = yield* integrations.oauth.connect({
            integrationID,
            methodID: Integration.MethodID.make("device"),
            answer: { server: `${server.url.origin}/console///?ignored=true#ignored` },
          })
          expect(attempt.url).toBe(`${server.url.origin}/console/device?user_code=user&client_id=opencode-cli`)
          yield* eventually(
            integrations.oauth.status({ integrationID, attemptID: attempt.attemptID }),
            (status) => status.status === "complete",
          )

          expect(requests).toContain("POST /console/auth/device/code")
          expect(requests).toContain("POST /console/auth/device/token")
          expect(requests).toContain("GET /console/api/user")
          expect(requests).toContain("GET /console/api/orgs")
          const credentials = yield* Credential.Service
          expect((yield* credentials.list(Integration.ID.make("opencode")))[0]?.value).toMatchObject({
            metadata: { server: `${server.url.origin}/console` },
          })
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("rejects malformed device verification URLs", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: () =>
            Response.json({
              device_code: "device",
              user_code: "user",
              verification_uri_complete: "http://[::1",
              expires_in: 60,
              interval: 0,
            }),
        }),
      ),
      (server) =>
        Effect.gen(function* () {
          yield* addPlugin()
          const integrations = yield* Integration.Service
          const error = yield* integrations.oauth
            .connect({
              integrationID: Integration.ID.make("opencode"),
              methodID: Integration.MethodID.make("device"),
              answer: { server: server.url.origin },
            })
            .pipe(Effect.flip)
          expect(error).toBeInstanceOf(Integration.AuthorizationError)
          expect(String(error.cause)).toContain("Invalid device verification URL")
        }),
      (server) => Effect.promise(() => server.stop(true)),
    ),
  )

  for (const orgID of ["org-z", undefined, null, "org-missing"]) {
    it.live(`uses the device token organization during authorization: ${orgID}`, () =>
      Effect.acquireUseRelease(
        Effect.sync(() => consoleServer(orgID)),
        ({ server, config }) =>
          Effect.gen(function* () {
            yield* addPlugin()
            const integrations = yield* Integration.Service
            const credentials = yield* Credential.Service
            const integrationID = Integration.ID.make("opencode")
            const attempt = yield* integrations.oauth.connect({
              integrationID,
              methodID: Integration.MethodID.make("device"),
              answer: { server: server.url.origin },
            })
            const status = yield* eventually(
              integrations.oauth.status({ integrationID, attemptID: attempt.attemptID }),
              (status) => status.status !== "pending",
            )
            if (orgID === "org-missing") {
              expect(status).toMatchObject({
                status: "failed",
                message: "OpenCode organization not found: org-missing",
              })
              expect(yield* credentials.list(integrationID)).toEqual([])
              expect(config).toEqual([])
              return
            }
            expect(status.status).toBe("complete")
            expect((yield* credentials.list(integrationID))[0]).toMatchObject({
              label: orgID === "org-z" ? "Zebra" : "Alpha",
              value: {
                type: "oauth",
                access: "access",
                refresh: "refresh",
                metadata: {
                  server: server.url.origin,
                  accountID: "user",
                  email: "user@example.com",
                  orgID: orgID ?? "org-a",
                  orgName: orgID === "org-z" ? "Zebra" : "Alpha",
                },
              },
            })
            yield* eventually(
              Effect.sync(() => config.length),
              (count) => count > 0,
            )
            expect(config).toEqual([{ authorization: "Bearer access", orgID: orgID ?? "org-a" }])
          }),
        ({ server }) => Effect.promise(() => server.stop(true)),
      ),
    )
  }

  for (const scenario of [
    { orgID: "org-z" },
    { orgID: undefined },
    { orgID: null },
    { orgID: "org-missing" },
    { orgID: "org-z", unavailable: true },
    { orgID: "org-a", unavailable: true },
  ]) {
    it.live(
      `persists rotated credentials for ${scenario.orgID}${scenario.unavailable ? " with discovery unavailable" : ""}`,
      () =>
        Effect.acquireUseRelease(
          Effect.sync(() => consoleServer(scenario.orgID, scenario.unavailable)),
          ({ server, config, requests, agents }) =>
            Effect.gen(function* () {
              const credentials = yield* Credential.Service
              const initial = yield* credentials.create({
                integrationID: Integration.ID.make("opencode"),
                label: "Custom label",
                value: Credential.OAuth.make({
                  type: "oauth",
                  methodID: Integration.MethodID.make("device"),
                  access: "expired-access",
                  refresh: "old-refresh",
                  expires: 0,
                  metadata: { server: server.url.origin, orgID: "org-a", orgName: "Alpha", custom: "preserved" },
                }),
              })
              yield* addPlugin()
              const stored = required(yield* credentials.get(initial.id))
              expect(stored).toMatchObject({
                label: "Custom label",
                value: {
                  access: "access",
                  refresh: "refresh",
                  metadata: {
                    server: server.url.origin,
                    orgID: scenario.orgID ?? "org-a",
                    orgName: scenario.orgID === "org-a" ? "Alpha" : (scenario.orgID ?? "Alpha"),
                    custom: "preserved",
                  },
                },
              })
              if (stored.value.type !== "oauth") throw new Error("Expected OAuth credential")
              expect(stored.value.expires).toBeGreaterThan(Date.now())
              if (scenario.orgID == null) expect(stored.value.metadata).toEqual(initial.value.metadata)
              expect(config).toEqual([{ authorization: "Bearer access", orgID: scenario.orgID ?? "org-a" }])
              const integrations = yield* Integration.Service
              expect(
                yield* integrations.connection.resolve({
                  type: "credential",
                  method: "oauth",
                  id: initial.id,
                  label: initial.label,
                }),
              ).toEqual(stored.value)
              expect(requests).toEqual(["/auth/device/token", "/api/v2/config"])
              // The refresh and the config fetch both say which OpenCode is asking.
              expect(agents).toEqual(["opencode/beta/1.2.3/test", "opencode/beta/1.2.3/test"])
            }).pipe(Effect.provideService(App.Metadata, App.make({ name: "test", version: "1.2.3", channel: "beta" }))),
          ({ server }) => Effect.promise(() => server.stop(true)),
        ),
    )
  }

  it.effect("rejects non-HTTP OpenCode servers", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const integrations = yield* Integration.Service
      const error = yield* integrations.oauth
        .connect({
          integrationID: Integration.ID.make("opencode"),
          methodID: Integration.MethodID.make("device"),
          answer: { server: "ftp://console.example.com" },
        })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(Integration.AuthorizationError)
      expect(String(error.cause)).toContain("Invalid OpenCode server URL: expected HTTP(S)")
    }),
  )

  it.effect("rejects non-string OpenCode servers", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const integrations = yield* Integration.Service
      const error = yield* integrations.oauth
        .connect({
          integrationID: Integration.ID.make("opencode"),
          methodID: Integration.MethodID.make("device"),
          answer: { server: true },
        })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(Integration.AuthorizationError)
      expect(String(error.cause)).toContain("Expected string for form field: server")
    }),
  )

  it.live("loads native V2 providers and models from the connected OpenCode server", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const authorization: Array<string | null> = []
        const requests: string[] = []
        return {
          authorization,
          requests,
          server: Bun.serve({
            port: 0,
            fetch: (request) => {
              authorization.push(request.headers.get("authorization"))
              requests.push(`${request.method} ${new URL(request.url).pathname}`)
              const origin = new URL(request.url).origin
              return Response.json({
                providers: {
                  remote: {
                    canonical: "openai",
                    name: "Remote",
                    package: "aisdk:@ai-sdk/openai-compatible",
                    env: ["REMOTE_API_KEY"],
                    settings: {
                      baseURL: `${origin}/v1`,
                      apiKey: "{env:REMOTE_API_KEY}",
                      authToken: "provider-auth",
                      accessToken: "provider-access",
                      custom: "value",
                    },
                    headers: { "x-org-id": "org" },
                    models: {
                      model: {
                        modelID: "api-model",
                        name: "Remote Model",
                        family: "remote",
                        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
                        settings: {
                          apiKey: "model-secret",
                          authToken: "model-auth",
                          accessToken: "model-access",
                          temperature: 0.5,
                        },
                        variants: [
                          {
                            id: "high",
                            settings: {
                              apiKey: "variant-secret",
                              authToken: "variant-auth",
                              accessToken: "variant-access",
                              temperature: 0.2,
                            },
                            headers: { "x-variant": "high" },
                          },
                        ],
                        cost: { input: 1, output: 2, cache: { read: 0.1 } },
                        limit: { context: 1000, output: 100 },
                      },
                      override: {
                        name: "Override",
                        package: "aisdk:@ai-sdk/anthropic",
                        settings: { baseURL: `${origin}/anthropic` },
                      },
                      disabled: { name: "Disabled", disabled: true },
                    },
                  },
                },
              })
            },
          }),
        }
      }),
      ({ authorization, requests, server }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const providers = yield* Provider.Service
          const models = yield* Model.Service
          const integrations = yield* Integration.Service
          yield* providers.transform((editor) => {
            editor.update(Provider.ID.openai, (provider) => {
              provider.package = "@opencode/ai/providers/openai"
              provider.integrationID = Integration.ID.make("openai")
            })
            editor.models.update(Provider.ID.openai, Model.ID.make("api-model"), (model) => {
              model.package = "@opencode/ai/providers/openai"
              model.settings = { baseURL: "https://upstream.example/v1" }
              model.variants = [
                {
                  id: Model.VariantID.make("custom"),
                  settings: {},
                  headers: { "x-custom": "true" },
                  body: { custom: true },
                },
              ]
            })
            editor.models.update(Provider.ID.make("remote"), Model.ID.make("stale"), () => {})
          })
          const initial = yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({
              type: "key",
              key: "secret",
              metadata: { server: server.url.origin },
            }),
          })

          yield* addPlugin()
          expect(authorization).toEqual(["Bearer secret"])
          expect(requests).toEqual(["GET /api/v2/config"])

          const provider = required(yield* providers.get(Provider.ID.make("remote")))
          expect(provider).toMatchObject({
            id: "remote",
            canonical: "openai",
            name: "Remote",
            integrationID: "opencode",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `${server.url.origin}/v1`, custom: "value" },
            headers: { "x-org-id": "org" },
          })
          expect(yield* integrations.get(Integration.ID.make("remote"))).toBeUndefined()

          const model = required(yield* models.get(Provider.ID.make("remote"), Model.ID.make("model")))
          expect(model).toMatchObject({
            id: "model",
            modelID: "api-model",
            providerID: "remote",
            canonical: "openai",
            name: "Remote Model",
            family: "remote",
            capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
            cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0 } }],
            limit: { context: 1000, output: 100 },
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `${server.url.origin}/v1`, custom: "value", temperature: 0.5 },
            headers: { "x-org-id": "org" },
          })
          expect(model.settings).toEqual({
            baseURL: `${server.url.origin}/v1`,
            custom: "value",
            temperature: 0.5,
            provider: "openai",
          })
          const override = required(yield* models.get(Provider.ID.make("remote"), Model.ID.make("override")))
          expect(override.package).toBe("@opencode/ai/providers/anthropic")
          expect(override.settings?.baseURL).toBe(`${server.url.origin}/anthropic`)
          expect(model.variants).toEqual([
            {
              id: Model.VariantID.make("custom"),
              settings: {},
              headers: { "x-custom": "true" },
              body: { custom: true },
            },
            {
              id: Model.VariantID.make("high"),
              settings: { temperature: 0.2 },
              headers: { "x-variant": "high" },
            },
          ])
          expect(required(yield* models.get(Provider.ID.make("remote"), Model.ID.make("disabled"))).enabled).toBe(false)
          expect(yield* models.get(Provider.ID.make("remote"), Model.ID.make("stale"))).toBeDefined()
          expect(
            (yield* providers.snapshot()).records.get(Provider.ID.openai)?.models.get(Model.ID.make("api-model"))
              ?.settings?.baseURL,
          ).toBe("https://upstream.example/v1")
          expect(yield* models.get(Provider.ID.openai, Model.ID.make("api-model"))).toBeUndefined()

          yield* credentials.update(initial.id, { label: "Renamed" })
          yield* Effect.yieldNow
          expect(authorization).toEqual(["Bearer secret"])

          const replacement = yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({
              type: "key",
              key: "replacement",
              metadata: { server: server.url.origin },
            }),
          })
          yield* eventually(
            Effect.sync(() => authorization.length),
            (count) => count === 2,
          )
          expect(authorization).toEqual(["Bearer secret", "Bearer replacement"])
          expect(requests).toEqual(["GET /api/v2/config", "GET /api/v2/config"])

          yield* credentials.remove(initial.id)
          yield* Effect.yieldNow
          expect(authorization).toEqual(["Bearer secret", "Bearer replacement"])
          expect((yield* credentials.list(Integration.ID.make("opencode"))).at(-1)?.id).toBe(replacement.id)
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("builds Console model variants from its reasoning and applies its release date", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: () =>
            Response.json({
              providers: {
                remote: {
                  name: "Remote",
                  package: "aisdk:@ai-sdk/openai",
                  models: {
                    reasoner: {
                      releaseDate: "2026-02-03",
                      capabilities: { reasoning: { supported: true, effort: ["default", "low", "high"] } },
                      variants: [{ id: "high", headers: { "x-tier": "high" } }],
                    },
                  },
                },
              },
            }),
        }),
      ),
      (server) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const models = yield* Model.Service
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({ type: "key", key: "secret", metadata: { server: server.url.origin } }),
          })

          yield* addPlugin()

          const reasoner = required(yield* models.get(Provider.ID.make("remote"), Model.ID.make("reasoner")))
          expect(reasoner.time.released).toBe(Date.UTC(2026, 1, 3))
          expect(reasoner.variants).toEqual([
            {
              id: Model.VariantID.make("low"),
              settings: { reasoningEffort: "low", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
            },
            {
              id: Model.VariantID.make("high"),
              settings: { reasoningEffort: "high", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
              headers: { "x-tier": "high" },
            },
          ])
        }),
      (server) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect("refreshes hosted search with Console config, retains it on failure, and skips unchanged snapshots", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const state = { advertised: false, failing: false, requests: 0 }
        const server = Bun.serve({
          port: 0,
          fetch: () => {
            state.requests++
            if (state.failing) return new Response("Unavailable", { status: 502 })
            return Response.json({
              providers: {},
              ...(state.advertised ? { websearch: { providerID: "opencode" } } : {}),
            })
          },
        })
        return { server, state }
      }),
      ({ server, state }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const providers = yield* Provider.Service
          const websearch = yield* WebSearch.Service
          const rebuilds = { provider: 0, websearch: 0 }
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({ type: "key", key: "secret", metadata: { server: server.url.origin } }),
          })
          yield* providers.transform(() => {
            rebuilds.provider++
          })
          yield* websearch.transform(() => {
            rebuilds.websearch++
          })
          yield* addPlugin().pipe(inProcess(server))
          yield* drain
          const initial = { ...rebuilds }
          expect(state.requests).toBe(1)
          expect(yield* websearch.default()).toBeUndefined()

          state.advertised = true
          yield* TestClock.adjust("50 seconds")
          yield* drain
          expect(state.requests).toBe(1)
          expect(rebuilds).toEqual(initial)
          expect(yield* websearch.default()).toBeUndefined()

          yield* TestClock.adjust("10 seconds")
          yield* drain
          expect(state.requests).toBe(2)
          expect(rebuilds).toEqual({ provider: initial.provider + 1, websearch: initial.websearch + 1 })
          expect(yield* websearch.default()).toEqual({ id: WebSearch.ID.make("opencode"), name: "OpenCode Web Search" })

          yield* TestClock.adjust("1 minute")
          yield* drain
          expect(state.requests).toBe(3)
          expect(rebuilds).toEqual({ provider: initial.provider + 1, websearch: initial.websearch + 1 })
          expect(yield* websearch.default()).toEqual({ id: WebSearch.ID.make("opencode"), name: "OpenCode Web Search" })

          state.failing = true
          yield* TestClock.adjust("1 minute")
          yield* drain
          expect(state.requests).toBe(4)
          expect(rebuilds).toEqual({ provider: initial.provider + 1, websearch: initial.websearch + 1 })
          expect(yield* websearch.default()).toEqual({ id: WebSearch.ID.make("opencode"), name: "OpenCode Web Search" })

          state.failing = false
          state.advertised = false
          yield* TestClock.adjust("1 minute")
          yield* drain
          expect(state.requests).toBe(5)
          expect(rebuilds).toEqual({ provider: initial.provider + 2, websearch: initial.websearch + 2 })
          expect(yield* websearch.providers()).toEqual([])
          expect(yield* websearch.default()).toBeUndefined()
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect("registers the Console's MCP servers as sent, attaching the credential only where asked", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const state = { advertised: true }
        const server = Bun.serve({
          port: 0,
          fetch: (request) =>
            Response.json({
              providers: {},
              ...(state.advertised
                ? {
                    mcp: {
                      servers: {
                        opencode_console: {
                          type: "remote",
                          url: `${new URL(request.url).origin}/console/mcp`,
                          headers: { "x-client": "opencode", authorization: "Bearer forged" },
                          oauth: false,
                          auth: "console",
                        },
                        opencode_console_oauth: {
                          type: "remote",
                          url: `${new URL(request.url).origin}/console/oauth/mcp`,
                          oauth: { scope: "workspace" },
                          timeout: { startup: 5000 },
                        },
                      },
                    },
                  }
                : {}),
            }),
        })
        return { server, state }
      }),
      ({ server, state }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const transforms: Array<(editor: Mcp.Editor) => void> = []
          const reloads = { count: 0 }
          const servers = () => {
            const configured = new Map<string, unknown>()
            transforms.forEach((transform) =>
              transform({
                list: () => [],
                get: (name) => (configured.has(name) ? { type: "remote", url: "user" } : undefined),
                set: (name, config) => configured.set(name, config),
                update: () => {},
                remove: (name) => configured.delete(name),
              }),
            )
            return Object.fromEntries(configured)
          }
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({
              type: "key",
              key: "secret",
              metadata: { server: server.url.origin, orgID: "org-a" },
            }),
          })
          yield* addPlugin().pipe(
            Effect.provideService(
              Mcp.Service,
              Mcp.Service.of({
                ...emptyMcp,
                transform: (transform) =>
                  Effect.sync(() => {
                    transforms.push(transform)
                    return { dispose: Effect.void }
                  }),
                reload: () =>
                  Effect.sync(() => {
                    reloads.count++
                  }),
              }),
            ),
            inProcess(server),
          )
          yield* drain

          expect(servers()).toEqual({
            opencode_console: {
              type: "remote",
              url: `${server.url.origin}/console/mcp`,
              headers: { "x-client": "opencode", authorization: "Bearer secret", "x-org-id": "org-a" },
              oauth: false,
            },
            opencode_console_oauth: {
              type: "remote",
              url: `${server.url.origin}/console/oauth/mcp`,
              oauth: { scope: "workspace" },
              timeout: { startup: 5000 },
            },
          })

          state.advertised = false
          yield* TestClock.adjust("1 minute")
          yield* drain
          expect(servers()).toEqual({})
          expect(reloads.count).toBe(1)
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect("ignores unsupported managed actions, effects, and keys while enforcing supported policies", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: () =>
            Response.json({
              providers: { opencode: {} },
              experimental: {
                policies: [
                  { action: "future.use", resource: { names: ["anything"] }, effect: "future-effect", future: true },
                  { action: "provider.use", resource: "*", effect: "deny" },
                  { action: "provider.use", resource: "opencode", effect: "allow" },
                  { action: "tool.use", resource: "shell:*", effect: "deny" },
                  { action: "tool.use", resource: "shell:git *", effect: "allow" },
                  { action: "tool.use", resource: "shell:git status", effect: "future-effect" },
                  { action: "permission", resource: "*", effect: "deny" },
                  { action: "tool.use", resource: "shell:sudo *", effect: "deny", audience: "ignored" },
                  { action: "integration.use", resource: "mcp:restricted", effect: "deny" },
                ],
                unknown: { future: true },
              },
              future: { unknown: true },
            }),
        }),
      ),
      (server) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const catalog = yield* Provider.Service
          const managed = yield* ManagedPolicy.Service
          const plugins = yield* Plugin.Service
          yield* catalog.transform((catalog) => catalog.update(Provider.ID.anthropic, () => {}))
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({
              type: "key",
              key: "secret",
              metadata: { server: server.url.origin, orgID: "org_test", orgName: "Acme" },
            }),
          })
          const host = yield* PluginHost.make(plugins)
          yield* OpencodePlugin.effect(host)
          yield* ConfigPolicyPlugin.Plugin.effect(host).pipe(Effect.provide(Config.testLayer([])))

          expect(managed.current()).toEqual({
            statements: [
              { action: "provider.use", resource: "*", effect: "deny" },
              { action: "provider.use", resource: "opencode", effect: "allow" },
              { action: "tool.use", resource: "shell:*", effect: "deny" },
              { action: "tool.use", resource: "shell:git *", effect: "allow" },
              { action: "tool.use", resource: "shell:sudo *", effect: "deny" },
              { action: "integration.use", resource: "mcp:restricted", effect: "deny" },
            ],
            organization: "Acme",
          })
          const hooks = yield* PluginHooks.Service
          const decision = yield* hooks.trigger("permission", "evaluate", {
            sessionID: Session.ID.make("ses_tool_policy"),
            action: "shell",
            resources: ["sudo ls"],
            effect: "allow",
          })
          expect(decision.effect).toBe("deny")
          expect(decision.message).toBe("Blocked by Acme's policy")
          expect(
            (yield* hooks.trigger("permission", "evaluate", {
              sessionID: Session.ID.make("ses_tool_policy"),
              action: "shell",
              resources: ["git status"],
              effect: "ask",
            })).effect,
          ).toBe("ask")
          expect(yield* catalog.get(Provider.ID.anthropic)).toBeUndefined()
          expect(yield* catalog.get(Provider.ID.opencode)).toBeDefined()
        }),
      (server) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect("refreshes past future-only policies while retaining config on malformed statements", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const state: { policies: unknown[] } = {
          policies: [{ action: "tool.use", resource: "shell:sudo *", effect: "deny" }],
        }
        const server = Bun.serve({
          port: 0,
          fetch: () => Response.json({ providers: { opencode: {} }, experimental: { policies: state.policies } }),
        })
        return { server, state }
      }),
      ({ server, state }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const managed = yield* ManagedPolicy.Service
          const providers = yield* Provider.Service
          const sudo: ConfigPolicy.Info = { action: "tool.use", resource: "shell:sudo *", effect: "deny" }
          const env: ConfigPolicy.Info = { action: "tool.use", resource: "edit:*.env", effect: "deny" }
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({
              type: "key",
              key: "secret",
              metadata: { server: server.url.origin, orgID: "org_acme", orgName: "Acme" },
            }),
          })
          yield* addPlugin().pipe(inProcess(server))
          yield* drain
          expect(managed.current()).toEqual({ statements: [sudo], organization: "Acme" })

          for (const malformed of [
            { action: "tool.use", resource: 42, effect: "deny" },
            { action: "tool.use", effect: "deny" },
            null,
            {},
          ]) {
            state.policies = [env, malformed]
            yield* TestClock.adjust("1 minute")
            yield* drain
            expect(managed.current()).toEqual({ statements: [sudo], organization: "Acme" })
            expect(yield* providers.get(Provider.ID.opencode)).toBeDefined()
          }

          state.policies = [env, { action: "tool.use", resource: "shell:*", effect: "future-effect" }]
          yield* TestClock.adjust("1 minute")
          yield* drain
          expect(managed.current()).toEqual({ statements: [env], organization: "Acme" })

          state.policies = [{ action: "future.use", future: { values: [true] } }]
          yield* TestClock.adjust("1 minute")
          yield* drain
          expect(managed.current()).toEqual({ statements: [], organization: "Acme" })
          expect(yield* providers.get(Provider.ID.opencode)).toBeDefined()

          state.policies = [{ action: "future.use", effect: { next: true } }, env]
          yield* TestClock.adjust("1 minute")
          yield* drain
          expect(managed.current()).toEqual({ statements: [env], organization: "Acme" })
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect("keeps policy statements bound to the connected Console account", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const state: { status: number; policies: Record<string, unknown[]>; requests: number } = {
          status: 200,
          policies: {},
          requests: 0,
        }
        const server = Bun.serve({
          port: 0,
          fetch: (request) => {
            state.requests++
            if (state.status !== 200) return new Response("Unavailable", { status: state.status })
            const policies = state.policies[request.headers.get("x-org-id") ?? ""]
            return Response.json({ providers: {}, ...(policies ? { experimental: { policies } } : {}) })
          },
        })
        return { server, state }
      }),
      ({ server, state }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const providers = yield* Provider.Service
          const managed = yield* ManagedPolicy.Service
          const rebuilds = { count: 0 }
          const account = (orgID: string, orgName: string) =>
            credentials.create({
              integrationID: Integration.ID.make("opencode"),
              value: Credential.Key.make({
                type: "key",
                key: orgID,
                metadata: { server: server.url.origin, orgID, orgName },
              }),
            })
          const sudo: ConfigPolicy.Info = { action: "tool.use", resource: "shell:sudo *", effect: "deny" }
          const env: ConfigPolicy.Info = { action: "tool.use", resource: "edit:*.env", effect: "deny" }
          yield* providers.transform(() => {
            rebuilds.count++
          })
          const alpha = yield* account("org_alpha", "Alpha")
          yield* addPlugin().pipe(inProcess(server))
          yield* drain
          const initial = rebuilds.count
          expect(state.requests).toBe(1)
          expect(managed.current()).toEqual({ statements: [], organization: "Alpha" })

          state.policies.org_alpha = [sudo]
          yield* TestClock.adjust("1 minute")
          yield* drain
          expect(state.requests).toBe(2)
          expect(managed.current()).toEqual({ statements: [sudo], organization: "Alpha" })
          expect(rebuilds.count).toBe(initial + 1)

          yield* TestClock.adjust("1 minute")
          yield* drain
          expect(state.requests).toBe(3)
          expect(rebuilds.count).toBe(initial + 1)

          // An outage for the same connection keeps the last statements instead of lifting them.
          state.status = 503
          yield* TestClock.adjust("1 minute")
          yield* drain
          expect(state.requests).toBe(4)
          expect(managed.current()).toEqual({ statements: [sudo], organization: "Alpha" })
          expect(rebuilds.count).toBe(initial + 1)

          state.status = 200
          state.policies.org_beta = [env]
          const beta = yield* account("org_beta", "Beta")
          yield* eventually(
            Effect.sync(() => managed.current()),
            (current) => current.organization === "Beta",
          )
          expect(managed.current()).toEqual({ statements: [env], organization: "Beta" })

          state.status = 404
          yield* TestClock.adjust("1 minute")
          yield* drain
          expect(managed.current()).toEqual({ statements: [], organization: "Beta" })

          state.status = 200
          yield* credentials.remove(beta.id)
          yield* eventually(
            Effect.sync(() => managed.current()),
            (current) => current.organization === "Alpha",
          )
          expect(managed.current()).toEqual({ statements: [sudo], organization: "Alpha" })

          yield* credentials.remove(alpha.id)
          yield* eventually(
            Effect.sync(() => managed.current()),
            (current) => current.organization === undefined,
          )
          expect(managed.current()).toEqual({ statements: [], organization: undefined })
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect("reports Console SSO sign-in, keeps the last config, and clears once Console accepts again", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const state = { sso: false }
        const server = Bun.serve({
          port: 0,
          fetch: () => {
            if (state.sso)
              return Response.json(
                { _tag: "SsoRequired", orgId: "org_acme", connectionId: "ssoconn/1" },
                { status: 403 },
              )
            return Response.json({
              providers: {},
              experimental: { policies: [{ action: "tool.use", resource: "shell:sudo *", effect: "deny" }] },
            })
          },
        })
        return { server, state }
      }),
      ({ server, state }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const integrations = yield* Integration.Service
          const managed = yield* ManagedPolicy.Service
          const status = () =>
            integrations
              .get(Integration.ID.make("opencode"))
              .pipe(Effect.map((integration) => integration?.connections[0]?.status))
          const sudo: ConfigPolicy.Info = { action: "tool.use", resource: "shell:sudo *", effect: "deny" }
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({
              type: "key",
              key: "secret",
              metadata: { server: `${server.url.origin}/console`, orgID: "org_acme", orgName: "Acme" },
            }),
          })
          yield* addPlugin().pipe(inProcess(server))
          yield* drain
          expect(yield* status()).toBeUndefined()

          state.sso = true
          yield* TestClock.adjust("1 minute")
          yield* drain
          const url = `${server.url.origin}/console/auth/sso/ssoconn%2F1/start?redirectTo=%2Fconsole%2F`
          expect(yield* status()).toEqual({ status: "needs_auth", message: "Sign in with SSO again to use Acme", url })
          expect(managed.current()).toEqual({ statements: [sudo], organization: "Acme" })

          state.sso = false
          yield* TestClock.adjust("1 minute")
          yield* drain
          expect(yield* status()).toBeUndefined()
          expect(managed.current()).toEqual({ statements: [sudo], organization: "Acme" })
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("explains rejected Console inference with the sign-in the connection needs", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const state = { sso: false }
        const server = Bun.serve({
          port: 0,
          fetch: () => {
            if (state.sso)
              return Response.json(
                { _tag: "SsoRequired", orgId: "org_acme", connectionId: "ssoconn_1" },
                { status: 403 },
              )
            return Response.json({ providers: { remote: { canonical: "openai" } } })
          },
        })
        return { server, state }
      }),
      ({ server, state }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const hooks = yield* PluginHooks.Service
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({
              type: "key",
              key: "secret",
              metadata: { server: server.url.origin, orgID: "org_acme", orgName: "Acme" },
            }),
          })
          yield* addPlugin()
          const rejected = (providerID: Provider.ID) =>
            hooks
              .trigger("session", "http.response", {
                sessionID: Session.ID.make("ses_console"),
                agent: Agent.ID.make("build"),
                model: Model.Ref.make({ providerID, id: Model.ID.make("model") }),
                kind: "primary",
                request: new Request("https://inference.example/v1/responses"),
                response: Response.json({ error: { message: "Workspace access denied" } }, { status: 403 }),
              })
              .pipe(
                Effect.flatMap((event) =>
                  Effect.promise(async () => ({ status: event.response.status, body: await event.response.json() })),
                ),
              )
          const denied = { status: 403, body: { error: { message: "Workspace access denied" } } }

          expect(yield* rejected(Provider.ID.make("remote"))).toEqual(denied)

          state.sso = true
          const explained = {
            status: 403,
            body: {
              error: {
                type: "authentication_error",
                message: "Sign in with SSO again to use Acme.",
              },
            },
          }
          expect(yield* rejected(Provider.ID.make("remote"))).toEqual(explained)
          expect(yield* rejected(Provider.ID.opencode)).toEqual(explained)
          expect(yield* rejected(Provider.ID.anthropic)).toEqual(denied)
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect("ignores 403 responses that are not a Console SSO error", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const state: { body: Response | undefined } = { body: undefined }
        const server = Bun.serve({
          port: 0,
          fetch: () =>
            state.body ??
            Response.json({
              providers: {},
              experimental: { policies: [{ action: "tool.use", resource: "shell:sudo *", effect: "deny" }] },
            }),
        })
        return { server, state }
      }),
      ({ server, state }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const integrations = yield* Integration.Service
          const managed = yield* ManagedPolicy.Service
          const sudo: ConfigPolicy.Info = { action: "tool.use", resource: "shell:sudo *", effect: "deny" }
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({ type: "key", key: "secret", metadata: { server: server.url.origin } }),
          })
          yield* addPlugin().pipe(inProcess(server))
          yield* drain

          for (const body of [
            () => new Response("<html>Forbidden</html>", { status: 403, headers: { "content-type": "text/html" } }),
            () => Response.json({ _tag: "Forbidden", orgId: "org", connectionId: "ssoconn" }, { status: 403 }),
          ]) {
            state.body = body()
            yield* TestClock.adjust("1 minute")
            yield* drain
            expect((yield* integrations.get(Integration.ID.make("opencode")))?.connections[0]?.status).toBeUndefined()
            expect(managed.current().statements).toEqual([sudo])
          }
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect("releases unread Console config responses when the fetch completes", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const signals: AbortSignal[] = []
      const state = { status: 404 }
      const http = HttpClient.make((request, _url, signal) => {
        signals.push(signal)
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unavailable", state)))
      })
      yield* credentials.create({
        integrationID: Integration.ID.make("opencode"),
        value: Credential.Key.make({ type: "key", key: "secret", metadata: { server: "https://console.test" } }),
      })
      yield* addPlugin().pipe(Effect.provideService(HttpClient.HttpClient, http))
      yield* drain
      state.status = 503
      yield* TestClock.adjust("1 minute")
      yield* drain

      // An unreleased response is only aborted when garbage collected, which fails outside a request on workerd.
      expect(signals.map((signal) => signal.aborted)).toEqual([true, true])
    }),
  )

  it.effect("reports a rejected Console refresh token as signed out without removing the credential", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) => {
            if (new URL(request.url).pathname === "/auth/device/token")
              return Response.json(
                { error: "invalid_grant", error_description: "refresh token revoked" },
                { status: 400 },
              )
            return Response.json({ providers: {} })
          },
        }),
      ),
      (server) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const integrations = yield* Integration.Service
          const credential = yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.OAuth.make({
              type: "oauth",
              methodID: Integration.MethodID.make("device"),
              access: "expired",
              refresh: "revoked",
              expires: 0,
              metadata: { server: server.url.origin, orgID: "org_acme", orgName: "Acme" },
            }),
          })
          yield* addPlugin()
          yield* drain

          expect((yield* integrations.get(Integration.ID.make("opencode")))?.connections[0]?.status).toEqual({
            status: "needs_auth",
            message: "Reconnect OpenCode Console to continue",
          })
          expect((yield* credentials.get(credential.id))?.value).toMatchObject({ refresh: "revoked" })
        }),
      (server) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect("reports a Console session rejected before its token expires as signed out", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const state = { revoked: true, refreshes: 0 }
        const server = Bun.serve({
          port: 0,
          fetch: (request) => {
            if (new URL(request.url).pathname === "/auth/device/token") state.refreshes++
            if (state.revoked)
              return Response.json({ _tag: "Unauthorized", message: "Invalid or expired session" }, { status: 401 })
            return Response.json({ providers: {} })
          },
        })
        return { server, state }
      }),
      ({ server, state }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const integrations = yield* Integration.Service
          const credential = yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.OAuth.make({
              type: "oauth",
              methodID: Integration.MethodID.make("device"),
              access: "revoked",
              refresh: "refresh",
              expires: Number.MAX_SAFE_INTEGER,
              metadata: { server: server.url.origin, orgID: "org_acme", orgName: "Acme" },
            }),
          })
          const status = () =>
            integrations.get(Integration.ID.make("opencode")).pipe(Effect.map((item) => item?.connections[0]?.status))
          yield* addPlugin().pipe(inProcess(server))
          yield* drain

          expect(yield* status()).toEqual({ status: "needs_auth", message: "Reconnect OpenCode Console to continue" })
          expect((yield* credentials.get(credential.id))?.value).toMatchObject({ access: "revoked" })

          state.revoked = false
          yield* TestClock.adjust("1 minute")
          yield* drain
          expect(yield* status()).toBeUndefined()
          expect(state.refreshes).toBe(0)
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("loads and executes hosted web search from the connected OpenCode server", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const requests: Array<{
          method: string
          path: string
          authorization: string | null
          orgID: string | null
          body?: unknown
        }> = []
        const gate = Promise.withResolvers<void>()
        const state = { advertised: true, providerID: "opencode", waitForConfig: false }
        const server = Bun.serve({
          port: 0,
          fetch: async (request) => {
            const path = new URL(request.url).pathname
            const body = request.method === "POST" ? await request.json() : undefined
            requests.push({
              method: request.method,
              path,
              authorization: request.headers.get("authorization"),
              orgID: request.headers.get("x-org-id"),
              ...(body === undefined ? {} : { body }),
            })
            if (path === "/api/v2/config") {
              if (state.waitForConfig) await gate.promise
              return Response.json({
                providers: {},
                ...(state.advertised
                  ? {
                      websearch: {
                        providerID: "opencode",
                      },
                    }
                  : {}),
              })
            }
            if (path === "/api/websearch" || path === "/other/api/websearch") {
              return Response.json({
                providerID: state.providerID,
                results: [
                  {
                    url: "https://github.com/anomalyco/opencode",
                    title: "OpenCode",
                    content: "Open source AI coding agent.",
                    time: { published: 1_700_000_000_000 },
                  },
                ],
              })
            }
            return new Response("Not found", { status: 404 })
          },
        })
        return { gate, requests, server, state }
      }),
      ({ gate, requests, server, state }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const websearch = yield* WebSearch.Service
          const account = (access: string, serverURL = server.url.origin, orgID = "org_test") =>
            Credential.OAuth.make({
              type: "oauth",
              methodID: Integration.MethodID.make("device"),
              access,
              refresh: "refresh",
              expires: Date.now() + 600_000,
              metadata: { server: serverURL, orgID },
            })
          const initial = yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: account("secret"),
          })

          yield* addPlugin()
          expect(yield* websearch.providers()).toContainEqual({
            id: WebSearch.ID.make("opencode"),
            name: "OpenCode Web Search",
          })
          expect(yield* websearch.default()).toEqual({ id: WebSearch.ID.make("opencode"), name: "OpenCode Web Search" })
          expect(yield* websearch.query({ query: "effect web search" })).toEqual(
            new WebSearch.Response({
              providerID: WebSearch.ID.make("opencode"),
              results: [
                {
                  url: "https://github.com/anomalyco/opencode",
                  title: "OpenCode",
                  content: "Open source AI coding agent.",
                  time: { published: 1_700_000_000_000 },
                },
              ],
            }),
          )
          expect(requests).toEqual([
            {
              method: "GET",
              path: "/api/v2/config",
              authorization: "Bearer secret",
              orgID: "org_test",
            },
            {
              method: "POST",
              path: "/api/websearch",
              authorization: "Bearer secret",
              orgID: "org_test",
              body: { query: "effect web search", providerID: "opencode" },
            },
          ])

          yield* credentials.update(initial.id, {
            value: account("replacement"),
          })
          yield* websearch.query({ query: "fresh credential" })
          expect(requests.at(-1)).toMatchObject({
            method: "POST",
            authorization: "Bearer replacement",
            body: { query: "fresh credential", providerID: "opencode" },
          })

          yield* credentials.update(initial.id, {
            value: account("moved", `${server.url.origin}/other///?ignored=true#ignored`),
          })
          yield* websearch.query({ query: "updated server" })
          expect(requests.at(-1)).toMatchObject({
            method: "POST",
            path: "/other/api/websearch",
            authorization: "Bearer moved",
            orgID: "org_test",
            body: { query: "updated server", providerID: "opencode" },
          })
          yield* credentials.update(initial.id, {
            value: account("replacement"),
          })

          state.providerID = "unexpected"
          expect((yield* websearch.query({ query: "wrong provider" }).pipe(Effect.flip))._tag).toBe("WebSearch.Request")

          state.advertised = false
          state.waitForConfig = true
          const searchCount = requests.filter((request) => request.path === "/api/websearch").length
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: account("switched", server.url.origin, "org_switched"),
          })
          yield* eventually(
            Effect.sync(() => requests),
            (requests) => requests.some((request) => request.authorization === "Bearer switched"),
          )
          expect((yield* websearch.query({ query: "switch race" }).pipe(Effect.flip))._tag).toBe("WebSearch.Request")
          expect(requests.filter((request) => request.path === "/api/websearch")).toHaveLength(searchCount)
          gate.resolve()
          yield* eventually(websearch.providers(), (providers) =>
            providers.every((provider) => provider.id !== WebSearch.ID.make("opencode")),
          )
          expect(yield* websearch.default()).toBeUndefined()
          expect(requests.at(-1)).toMatchObject({
            method: "GET",
            path: "/api/v2/config",
            authorization: "Bearer switched",
            orgID: "org_switched",
          })
        }),
      ({ gate, server }) =>
        Effect.sync(() => gate.resolve()).pipe(Effect.andThen(Effect.promise(() => server.stop(true)))),
    ),
  )

  it.live("derives hosted search identity and the default Console endpoint locally", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) => {
            if (new URL(request.url).pathname === "/console/api/v2/config") {
              return Response.json({
                providers: {},
                websearch: {
                  providerID: "managed-search",
                  name: "Remote name",
                  url: "https://example.invalid/search",
                },
              })
            }
            return Response.json({ providerID: "managed-search", results: [] })
          },
        }),
      ),
      (server) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const websearch = yield* WebSearch.Service
          const http = yield* HttpClient.HttpClient
          const requests: string[] = []
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({ type: "key", key: "secret" }),
          })
          yield* addPlugin().pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              http.pipe(
                HttpClient.mapRequest((request) => {
                  requests.push(request.url)
                  return HttpClientRequest.setUrl(request, `${server.url.origin}${new URL(request.url).pathname}`)
                }),
              ),
            ),
          )

          expect(yield* websearch.default()).toEqual({
            id: WebSearch.ID.make("managed-search"),
            name: "OpenCode Web Search",
          })
          expect(yield* websearch.query({ query: "default Console" })).toEqual(
            new WebSearch.Response({ providerID: WebSearch.ID.make("managed-search"), results: [] }),
          )
          expect(requests).toEqual([
            "https://opencode.ai/console/api/v2/config",
            "https://opencode.ai/console/api/websearch",
          ])
        }),
      (server) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("does not forward hosted search credentials through redirects", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const requests: string[] = []
        const state = { crossOrigin: false }
        const server = Bun.serve({
          port: 0,
          fetch: (request) => {
            const url = new URL(request.url)
            requests.push(url.pathname)
            if (url.pathname === "/console/api/v2/config") {
              return Response.json({
                providers: {},
                websearch: {
                  providerID: "opencode",
                },
              })
            }
            if (url.pathname === "/console/api/websearch") {
              if (state.crossOrigin) url.hostname = "127.0.0.1"
              return Response.redirect(`${url.origin}/outside-console`, 307)
            }
            return Response.json({ providerID: "opencode", results: [] })
          },
        })
        return { requests, server, state }
      }),
      ({ requests, server, state }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const websearch = yield* WebSearch.Service
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({
              type: "key",
              key: "secret",
              metadata: { server: `${server.url.origin}/console`, orgID: "org_test" },
            }),
          })
          yield* addPlugin()

          expect((yield* websearch.query({ query: "private search" }).pipe(Effect.flip))._tag).toBe("WebSearch.Request")
          expect(requests).toEqual(["/console/api/v2/config", "/console/api/websearch"])

          state.crossOrigin = true
          expect((yield* websearch.query({ query: "private search" }).pipe(Effect.flip))._tag).toBe("WebSearch.Request")
          expect(requests).toEqual(["/console/api/v2/config", "/console/api/websearch", "/console/api/websearch"])
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("closes a rejected hosted search response without waiting for its body", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const state = { cancelled: false }
        const server = Bun.serve({
          port: 0,
          fetch: (request) => {
            const url = new URL(request.url)
            if (url.pathname === "/api/v2/config") {
              return Response.json({
                providers: {},
                websearch: {
                  providerID: "opencode",
                },
              })
            }
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("temporarily unavailable"))
                },
                cancel() {
                  state.cancelled = true
                },
              }),
              { status: 503 },
            )
          },
        })
        return { server, state }
      }),
      ({ server, state }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const websearch = yield* WebSearch.Service
          yield* credentials.create({
            integrationID: Integration.ID.make("opencode"),
            value: Credential.Key.make({
              type: "key",
              key: "secret",
              metadata: { server: server.url.origin, orgID: "org_test" },
            }),
          })
          yield* addPlugin()

          const error = yield* websearch.query({ query: "rejected search" }).pipe(Effect.flip)
          expect(error._tag).toBe("WebSearch.Request")
          yield* eventually(
            Effect.sync(() => state.cancelled),
            (cancelled) => cancelled,
          )
          // Callers can retain errors, so response cleanup must not depend on garbage collection.
          expect(error).toBeInstanceOf(WebSearch.RequestError)
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("preserves native Console OpenAI variant bodies in inference requests", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const variants = [
          {
            id: "effort-only",
            body: { reasoning: { effort: "low" } },
          },
          {
            id: "summary-only",
            body: { reasoning: { summary: "detailed" } },
          },
          {
            id: "native",
            body: { reasoning: { effort: "high", summary: "auto" } },
          },
          { id: "plain", body: {} },
        ]
        const models = {
          astra: {
            modelID: "api-astra",
            variants: variants.map((variant) => ({
              id: variant.id,
              headers: { "x-variant": variant.id },
              body: {
                ...variant.body,
                include: ["reasoning.encrypted_content"],
                metadata: { custom: "unchanged" },
              },
            })),
          },
        }
        const requests: { body: unknown; variant: string | null }[] = []
        return {
          variants,
          requests,
          server: Bun.serve({
            port: 0,
            fetch: async (request) => {
              if (new URL(request.url).pathname === "/responses") {
                requests.push({ body: await request.json(), variant: request.headers.get("x-variant") })
                return new Response('data: {"type":"response.completed","response":{"id":"resp_test"}}\n\n', {
                  headers: { "content-type": "text/event-stream" },
                })
              }
              return Response.json({
                providers: {
                  remote: {
                    canonical: "openai",
                    package: "aisdk:@ai-sdk/openai",
                    settings: { baseURL: new URL(request.url).origin },
                    models: {
                      ...models,
                      override: { ...models.astra, package: "aisdk:@ai-sdk/openai-compatible" },
                    },
                  },
                  compatible: {
                    canonical: "openai",
                    package: "aisdk:@ai-sdk/openai-compatible",
                    models,
                  },
                },
              })
            },
          }),
        }
      }),
      ({ variants, requests, server }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const models = yield* Model.Service
          const credential = Credential.Key.make({
            type: "key",
            key: "secret",
            metadata: { server: server.url.origin },
          })
          yield* credentials.create({ integrationID: Integration.ID.make("opencode"), value: credential })
          yield* addPlugin()
          const model = required(yield* models.get(Provider.ID.make("remote"), Model.ID.make("astra")))
          expect(model.canonical).toBe(Provider.ID.openai)
          yield* Effect.forEach(variants, (variant, index) =>
            Effect.gen(function* () {
              const projected = required(model.variants.find((item) => item.id === variant.id))
              expect(projected.body).toEqual({
                ...variant.body,
                include: ["reasoning.encrypted_content"],
                metadata: { custom: "unchanged" },
              })
              expect(projected.settings).toBeUndefined()
              const resolved = yield* ModelResolver.resolveModel(model, Model.VariantID.make(variant.id), credential)
              yield* LLMClient.stream(LLM.request({ model: resolved, prompt: "Hello" })).pipe(
                Stream.runDrain,
                Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer))),
              )
              expect(requests).toHaveLength(index + 1)
              const request = required(requests.at(-1))
              expect(request.variant).toBe(variant.id)
              expect(request.body).toMatchObject({
                ...variant.body,
                model: "api-astra",
                include: ["reasoning.encrypted_content"],
                metadata: { custom: "unchanged" },
              })
              expect(request.body).not.toHaveProperty("reasoningEffort")
              expect(request.body).not.toHaveProperty("reasoningSummary")
              if (variant.id === "plain") expect(request.body).not.toHaveProperty("reasoning")
            }),
          )
          const compatible = required(yield* models.get(Provider.ID.make("compatible"), Model.ID.make("astra")))
          const override = required(yield* models.get(Provider.ID.make("remote"), Model.ID.make("override")))
          for (const model of [compatible, override]) {
            expect(model.variants.find((variant) => variant.id === "native")?.body).toEqual({
              reasoning: { effort: "high", summary: "auto" },
              include: ["reasoning.encrypted_content"],
              metadata: { custom: "unchanged" },
            })
          }
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect("uses a public key and disables paid models without credentials", () =>
    withEnv({ OPENCODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Provider.Service
        const models = yield* Model.Service
        yield* catalog.transform((catalog) => {
          catalog.update(Provider.ID.opencode, () => {})
          catalog.models.update(Provider.ID.opencode, Model.ID.make("paid"), (draft) => {
            draft.cost = cost(1)
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.get(Provider.ID.opencode)).settings?.apiKey).toBe("public")
        expect(required(yield* models.get(Provider.ID.opencode, Model.ID.make("paid"))).enabled).toBe(false)
      }),
    ),
  )

  it.effect("keeps free models without credentials", () =>
    withEnv({ OPENCODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Provider.Service
        const models = yield* Model.Service
        yield* catalog.transform((catalog) => {
          catalog.update(Provider.ID.opencode, () => {})
          catalog.models.update(Provider.ID.opencode, Model.ID.make("free"), (draft) => {
            draft.cost = cost(0)
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.get(Provider.ID.opencode)).settings?.apiKey).toBe("public")
        expect(required(yield* catalog.get(Provider.ID.opencode)).activation).toBe("enabled")
        expect((yield* catalog.available()).map((provider) => provider.id)).toContain(Provider.ID.opencode)
        expect(required(yield* models.get(Provider.ID.opencode, Model.ID.make("free"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("treats output-only cost as free without credentials", () =>
    withEnv({ OPENCODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Provider.Service
        const models = yield* Model.Service
        yield* catalog.transform((catalog) => {
          catalog.update(Provider.ID.opencode, () => {})
          catalog.models.update(Provider.ID.opencode, Model.ID.make("output-only"), (draft) => {
            draft.cost = cost(0, 1)
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.get(Provider.ID.opencode)).settings?.apiKey).toBe("public")
        expect(required(yield* models.get(Provider.ID.opencode, Model.ID.make("output-only"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("uses OPENCODE_API_KEY as credentials", () =>
    withEnv({ OPENCODE_API_KEY: "secret" }, () =>
      Effect.gen(function* () {
        const catalog = yield* Provider.Service
        const models = yield* Model.Service
        const integrations = yield* Integration.Service
        yield* integrations.transform((editor) =>
          editor.method.update({
            integrationID: Integration.ID.make("opencode"),
            method: { type: "env", names: ["OPENCODE_API_KEY"] },
          }),
        )
        yield* catalog.transform((catalog) => {
          catalog.update(Provider.ID.opencode, () => {})
          catalog.models.update(Provider.ID.opencode, Model.ID.make("paid"), (draft) => {
            draft.cost = cost(1)
          })
        })
        yield* addPlugin().pipe(Effect.provideService(HttpClient.HttpClient, noRemoteConfig))
        expect(required(yield* catalog.get(Provider.ID.opencode)).settings?.apiKey).toBeUndefined()
        expect(required(yield* models.get(Provider.ID.opencode, Model.ID.make("paid"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("uses configured provider env vars as credentials", () =>
    withEnv({ OPENCODE_API_KEY: undefined, CUSTOM_OPENCODE_API_KEY: "secret" }, () =>
      Effect.gen(function* () {
        const catalog = yield* Provider.Service
        const models = yield* Model.Service
        const integrations = yield* Integration.Service
        yield* integrations.transform((editor) => {
          editor.method.update({
            integrationID: Integration.ID.make("opencode"),
            method: { type: "env", names: ["CUSTOM_OPENCODE_API_KEY"] },
          })
        })
        yield* catalog.transform((catalog) => {
          catalog.update(Provider.ID.opencode, () => {})
          catalog.models.update(Provider.ID.opencode, Model.ID.make("paid"), (draft) => {
            draft.cost = cost(1)
          })
        })
        // An env credential has no server metadata, so the plugin would ask the
        // default Console for remote config; answer 404 (no remote config) locally.
        yield* addPlugin().pipe(Effect.provideService(HttpClient.HttpClient, noRemoteConfig))
        expect(required(yield* catalog.get(Provider.ID.opencode)).settings?.apiKey).toBeUndefined()
        expect(required(yield* models.get(Provider.ID.opencode, Model.ID.make("paid"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("uses configured apiKey as credentials", () =>
    withEnv({ OPENCODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Provider.Service
        const models = yield* Model.Service
        yield* catalog.transform((catalog) => {
          catalog.update(Provider.ID.opencode, (draft) => {
            draft.package = Provider.aisdk("test-provider")
            draft.settings = { apiKey: "configured" }
            draft.activation = "enabled"
          })
          catalog.models.update(Provider.ID.opencode, Model.ID.make("paid"), (draft) => {
            draft.cost = cost(1)
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.get(Provider.ID.opencode)).settings?.apiKey).toBe("configured")
        expect(required(yield* models.get(Provider.ID.opencode, Model.ID.make("paid"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("ignores non-opencode providers and models", () =>
    withEnv({ OPENCODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const catalog = yield* Provider.Service
        const models = yield* Model.Service
        yield* catalog.transform((catalog) => {
          catalog.update(Provider.ID.openai, () => {})
          catalog.models.update(Provider.ID.openai, Model.ID.make("paid"), (draft) => {
            draft.cost = cost(1)
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.get(Provider.ID.openai)).settings?.apiKey).toBeUndefined()
        expect(required(yield* models.get(Provider.ID.openai, Model.ID.make("paid"))).enabled).toBe(true)
      }),
    ),
  )

  describe("OpenCode Go account sign-in and API-key precedence", () => {
    const consoleID = Integration.ID.make("opencode")
    const goID = Integration.ID.make("opencode-go")
    const goProviderID = Provider.ID.make("opencode-go")

    function seedGoCatalog(baseURL: string) {
      return Effect.gen(function* () {
        const integrations = yield* Integration.Service
        const providers = yield* Provider.Service
        yield* integrations.transform((editor) => {
          editor.update(consoleID, (integration) => (integration.name = "OpenCode"))
          editor.method.update({ integrationID: consoleID, method: { type: "key" } })
          editor.method.update({ integrationID: consoleID, method: { type: "env", names: ["OPENCODE_API_KEY"] } })

          editor.update(goID, (integration) => (integration.name = "OpenCode Go"))
          editor.method.update({ integrationID: goID, method: { type: "key" } })
          editor.method.update({ integrationID: goID, method: { type: "env", names: ["OPENCODE_API_KEY"] } })
        })
        yield* providers.transform((editor) => {
          editor.update(Provider.ID.opencode, (provider) => {
            provider.name = "OpenCode"
            provider.integrationID = consoleID
            provider.package = "@opencode/ai/providers/openai-compatible"
            provider.settings = { baseURL: `${baseURL}/zen/v1` }
          })
          editor.models.update(Provider.ID.opencode, Model.ID.make("big-pickle"), (model) => {
            model.name = "Big Pickle"
            model.modelID = Model.ID.make("big-pickle")
            model.cost = cost(0)
            model.capabilities = { tools: true, input: ["text"], output: ["text"] }
          })
          editor.models.update(Provider.ID.opencode, Model.ID.make("paid-zen"), (model) => {
            model.name = "Paid Zen"
            model.cost = cost(1, 2)
            model.capabilities = { tools: true, input: ["text"], output: ["text"] }
          })

          editor.update(goProviderID, (provider) => {
            provider.name = "OpenCode Go"
            provider.integrationID = goID
            provider.package = "@opencode/ai/providers/openai-compatible"
            provider.settings = { baseURL: `${baseURL}/zen/go/v1` }
          })
          editor.models.update(goProviderID, Model.ID.make("glm-5.3"), (model) => {
            model.name = "GLM-5.3"
            model.modelID = Model.ID.make("glm-5.3")
            model.cost = cost(1.4, 4.4)
            model.capabilities = { tools: true, input: ["text"], output: ["text"] }
            model.settings = { baseURL: `${baseURL}/zen/go/v1`, provider: "opencode-go" }
          })
        })
      })
    }

    function createGoServer() {
      const configCalls: Array<{ authorization: string | null; orgID: string | null }> = []
      const inferenceCalls: Array<{ path: string; authorization: string | null; orgID: string | null }> = []
      const state = {
        accessToken: "go-account-token-1",
        refreshToken: "go-account-refresh-1",
        orgID: "org-alpha",
        orgName: "Alpha",
        ssoRequired: false,
        rejectRefresh: false,
        policies: {} as Record<string, unknown[]>,
        goEntitled: true,
        consoleEntitled: false,
      }
      const server = Bun.serve({
        port: 0,
        fetch: async (request) => {
          const url = new URL(request.url)
          const origin = url.origin
          if (url.pathname === "/auth/device/code") {
            return Response.json({
              device_code: "dev_code",
              user_code: "ABCD-EFGH",
              verification_uri_complete: "/device?user_code=ABCD-EFGH",
              expires_in: 60,
              interval: 0,
            })
          }
          if (url.pathname === "/auth/device/token") {
            const body = (await request.json()) as Record<string, string>
            if (body.grant_type === "refresh_token") {
              if (state.rejectRefresh) {
                return Response.json({ error: "invalid_grant" }, { status: 400 })
              }
              return Response.json({
                access_token: "go-account-token-rotated",
                refresh_token: "go-account-refresh-rotated",
                expires_in: 600,
                org_id: state.orgID,
              })
            }
            return Response.json({
              access_token: state.accessToken,
              refresh_token: state.refreshToken,
              expires_in: 600,
              org_id: state.orgID,
            })
          }
          if (url.pathname === "/api/user") return Response.json({ id: "usr_1", email: "kit@example.com" })
          if (url.pathname === "/api/orgs") return Response.json([{ id: state.orgID, name: state.orgName }])
          if (url.pathname === "/api/v2/config") {
            const orgID = request.headers.get("x-org-id")
            configCalls.push({ authorization: request.headers.get("authorization"), orgID })
            if (state.ssoRequired) {
              return Response.json(
                { _tag: "SsoRequired", orgId: orgID ?? state.orgID, connectionId: "sso_1" },
                { status: 403 },
              )
            }
            const policies = orgID ? state.policies[orgID] : undefined
            return Response.json({
              providers: {
                ...(state.goEntitled
                  ? {
                      "opencode-go": {
                        name: "OpenCode Go",
                        package: "aisdk:@ai-sdk/openai-compatible",
                        settings: { baseURL: `${origin}/inference/go/openai/v1` },
                        headers: orgID ? { "x-opencode-org-id": orgID } : {},
                        models: {
                          "glm-5.3": { name: "GLM-5.3", modelID: "glm-5.3" },
                        },
                      },
                    }
                  : {}),
                ...(state.consoleEntitled
                  ? {
                      opencode: {
                        name: "OpenCode Zen",
                        package: "aisdk:@ai-sdk/openai-compatible",
                        settings: { baseURL: `${origin}/inference/zen/openai/v1` },
                        headers: orgID ? { "x-opencode-org-id": orgID } : {},
                        models: {
                          "paid-zen": {
                            name: "Paid Zen",
                            modelID: "paid-zen",
                            cost: { input: 5, output: 5 },
                          },
                        },
                      },
                    }
                  : {}),
              },
              ...(policies ? { policies } : {}),
            })
          }
          if (
            url.pathname === "/inference/go/openai/v1/chat/completions" ||
            url.pathname === "/inference/zen/openai/v1/chat/completions" ||
            url.pathname === "/zen/go/v1/chat/completions" ||
            url.pathname === "/zen/v1/chat/completions"
          ) {
            inferenceCalls.push({
              path: url.pathname,
              authorization: request.headers.get("authorization"),
              orgID: request.headers.get("x-opencode-org-id"),
            })
            if (url.pathname === "/zen/v1/chat/completions" && request.headers.get("authorization") !== "Bearer public") {
              return Response.json({ error: { message: "Expected public auth for free Zen" } }, { status: 401 })
            }
            const sse = [
              'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"glm-5.3","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}',
              'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"glm-5.3","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens\":1,\"total_tokens\":6}}',
              "data: [DONE]",
              "",
            ].join("\n\n")
            return new Response(sse, { headers: { "content-type": "text/event-stream" } })
          }
          return new Response("Not found", { status: 404 })
        },
      })
      return { server, configCalls, inferenceCalls, state }
    }

    const requestGo = Effect.gen(function* () {
      const resolver = yield* ModelResolver.Service
      const resolved = required(
        yield* resolver.resolve(Model.Ref.make({ providerID: goProviderID, id: Model.ID.make("glm-5.3") })),
      )
      yield* LLMClient.stream(LLM.request({ model: resolved.model, prompt: "hello" })).pipe(
        Stream.runDrain,
        Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer))),
      )
    })

    const requestBigPickle = Effect.gen(function* () {
      const resolver = yield* ModelResolver.Service
      const resolved = required(
        yield* resolver.resolve(Model.Ref.make({ providerID: Provider.ID.opencode, id: Model.ID.make("big-pickle") })),
      )
      yield* LLMClient.stream(LLM.request({ model: resolved.model, prompt: "hello" })).pipe(
        Stream.runDrain,
        Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer))),
      )
    })

    it.live(
      "Go-only account sign-in stores the canonical opencode credential, keeps free Zen models on public auth, sends the account token, and refreshes it",
      () =>
        withEnv({ OPENCODE_API_KEY: undefined }, () =>
          Effect.acquireUseRelease(
            Effect.sync(() => createGoServer()),
            ({ server, configCalls, inferenceCalls, state }) =>
              Effect.gen(function* () {
                yield* seedGoCatalog(server.url.origin)
                yield* addPlugin()

                const integrations = yield* Integration.Service
                const credentials = yield* Credential.Service
                const providers = yield* Provider.Service
                const models = yield* Model.Service

                const attempt = yield* integrations.oauth.connect({
                  integrationID: goID,
                  methodID: Integration.MethodID.make("device"),
                  answer: { server: server.url.origin },
                })
                const status = yield* eventually(
                  integrations.oauth.status({ integrationID: goID, attemptID: attempt.attemptID }),
                  (current) => current.status !== "pending",
                )
                expect(status.status).toBe("complete")

                // Stored once under canonical `opencode`, projected onto both rows.
                expect(yield* credentials.list(goID)).toEqual([])
                const stored = required((yield* credentials.list(consoleID))[0])
                expect((yield* integrations.get(consoleID))?.connections[0]).toMatchObject({
                  id: stored.id,
                  label: "Alpha",
                  method: "oauth",
                })
                expect((yield* integrations.get(goID))?.connections[0]).toMatchObject({
                  id: stored.id,
                  label: "Alpha",
                  method: "oauth",
                })

                yield* eventually(
                  providers.get(goProviderID),
                  (provider) => provider?.integrationID === consoleID,
                )
                expect(configCalls).toEqual([{ authorization: "Bearer go-account-token-1", orgID: "org-alpha" }])

                // Free `opencode` models (Big Pickle) stay available and enabled on `public`; paid Zen models stay disabled.
                expect(required(yield* providers.get(Provider.ID.opencode)).activation).toBe("enabled")
                expect(required(yield* providers.get(Provider.ID.opencode)).settings?.apiKey).toBe("public")
                expect((yield* providers.available()).map((p) => p.id)).toContain(Provider.ID.opencode)
                expect(required(yield* models.get(Provider.ID.opencode, Model.ID.make("big-pickle"))).enabled).toBe(
                  true,
                )
                expect(required(yield* models.get(Provider.ID.opencode, Model.ID.make("paid-zen"))).enabled).toBe(
                  false,
                )

                // Go inference carries the account token and workspace header; Big Pickle sends public auth to /zen/v1.
                yield* requestGo
                yield* requestBigPickle
                expect(inferenceCalls).toEqual([
                  {
                    path: "/inference/go/openai/v1/chat/completions",
                    authorization: "Bearer go-account-token-1",
                    orgID: "org-alpha",
                  },
                  {
                    path: "/zen/v1/chat/completions",
                    authorization: "Bearer public",
                    orgID: null,
                  },
                ])

                // Token refresh updates the canonical credential and serves the rotated token to Go inference.
                if (stored.value.type !== "oauth") throw new Error("Expected oauth")
                yield* credentials.update(stored.id, {
                  value: Credential.OAuth.make({ ...stored.value, expires: 0 }),
                })
                yield* requestGo
                expect(inferenceCalls[2]).toEqual({
                  path: "/inference/go/openai/v1/chat/completions",
                  authorization: "Bearer go-account-token-rotated",
                  orgID: "org-alpha",
                })

                // Even when the account is expired/revoked (refresh rejected), Big Pickle still skips OAuth resolution and sends public auth.
                state.rejectRefresh = true
                const refreshed = required((yield* credentials.list(consoleID))[0])
                if (refreshed.value.type !== "oauth") throw new Error("Expected oauth")
                yield* credentials.update(refreshed.id, {
                  value: Credential.OAuth.make({ ...refreshed.value, expires: 0 }),
                })
                yield* requestBigPickle
                expect(inferenceCalls[3]).toEqual({
                  path: "/zen/v1/chat/completions",
                  authorization: "Bearer public",
                  orgID: null,
                })

                // Full sign-out keeps Big Pickle on public auth.
                yield* credentials.remove(refreshed.id)
                yield* eventually(
                  Effect.map(integrations.get(consoleID), (info) => info?.connections.length ?? 0),
                  (count) => count === 0,
                )
                yield* requestBigPickle
                expect(inferenceCalls[4]).toEqual({
                  path: "/zen/v1/chat/completions",
                  authorization: "Bearer public",
                  orgID: null,
                })
              }).pipe(Effect.provide(ModelResolver.layer)),
            ({ server }) => Effect.promise(() => server.stop(true)),
          ),
        ),
    )

    it.live(
      "existing Go API-key user is unchanged and a dedicated Go key takes precedence over a shared OpenCode account",
      () =>
        withEnv({ OPENCODE_API_KEY: undefined }, () =>
          Effect.acquireUseRelease(
            Effect.sync(() => createGoServer()),
            ({ server, configCalls, inferenceCalls }) =>
              Effect.gen(function* () {
                yield* seedGoCatalog(server.url.origin)
                yield* addPlugin()

                const integrations = yield* Integration.Service
                const credentials = yield* Credential.Service
                const providers = yield* Provider.Service
                const models = yield* Model.Service

                // 1. Existing Go key-only user: no Console config fetch, free Zen intact, Go key used.
                yield* integrations.connection.key({ integrationID: goID, key: "go-personal-key" })
                yield* Effect.yieldNow
                expect(configCalls).toEqual([])
                expect(required(yield* providers.get(Provider.ID.opencode)).settings?.apiKey).toBe("public")
                expect(required(yield* models.get(Provider.ID.opencode, Model.ID.make("big-pickle"))).enabled).toBe(
                  true,
                )
                expect((yield* integrations.get(goID))?.connections[0]).toMatchObject({
                  label: "OpenCode Go",
                  method: "key",
                })

                yield* requestGo
                expect(inferenceCalls).toEqual([
                  {
                    path: "/zen/go/v1/chat/completions",
                    authorization: "Bearer go-personal-key",
                    orgID: null,
                  },
                ])

                // 2. Also sign in with an OpenCode account (with Go entitlement): dedicated Go key still wins on Go.
                const account = yield* credentials.create({
                  integrationID: consoleID,
                  label: "Alpha",
                  value: Credential.OAuth.make({
                    type: "oauth",
                    methodID: Integration.MethodID.make("device"),
                    access: "go-account-token-1",
                    refresh: "go-account-refresh-1",
                    expires: Date.now() + 600_000,
                    metadata: { server: server.url.origin, orgID: "org-alpha", orgName: "Alpha" },
                  }),
                })
                yield* eventually(
                  Effect.sync(() => configCalls.length),
                  (count) => count === 1,
                )
                expect((yield* integrations.get(consoleID))?.connections[0]).toMatchObject({
                  id: account.id,
                  label: "Alpha",
                  method: "oauth",
                })
                expect((yield* integrations.get(goID))?.connections[0]).toMatchObject({
                  label: "OpenCode Go",
                  method: "key",
                })

                yield* requestGo
                expect(inferenceCalls[1]).toEqual({
                  path: "/zen/go/v1/chat/completions",
                  authorization: "Bearer go-personal-key",
                  orgID: null,
                })

                // 3. Removing the dedicated Go key falls back to the active OpenCode account on Go.
                const goKey = required((yield* credentials.list(goID))[0])
                yield* credentials.remove(goKey.id)
                yield* eventually(
                  providers.get(goProviderID),
                  (provider) => provider?.integrationID === consoleID,
                )
                expect((yield* integrations.get(goID))?.connections[0]).toMatchObject({
                  id: account.id,
                  label: "Alpha",
                  method: "oauth",
                })

                yield* requestGo
                expect(inferenceCalls[2]).toEqual({
                  path: "/inference/go/openai/v1/chat/completions",
                  authorization: "Bearer go-account-token-1",
                  orgID: "org-alpha",
                })
              }).pipe(Effect.provide(ModelResolver.layer)),
            ({ server }) => Effect.promise(() => server.stop(true)),
          ),
        ),
    )

    it.live("preserves the original Go error when Console sign-in fails alongside an independent Go key", () =>
      withEnv({ OPENCODE_API_KEY: undefined }, () =>
        Effect.acquireUseRelease(
          Effect.sync(() => createGoServer()),
          ({ server, state }) =>
            Effect.gen(function* () {
              yield* seedGoCatalog(server.url.origin)
              state.ssoRequired = true

              const credentials = yield* Credential.Service
              const integrations = yield* Integration.Service
              const hooks = yield* PluginHooks.Service

              yield* credentials.create({
                integrationID: goID,
                value: Credential.Key.make({ type: "key", key: "go-independent-key" }),
              })
              yield* credentials.create({
                integrationID: consoleID,
                label: "Alpha",
                value: Credential.OAuth.make({
                  type: "oauth",
                  methodID: Integration.MethodID.make("device"),
                  access: "expired-sso-token",
                  refresh: "refresh",
                  expires: Date.now() + 600_000,
                  metadata: { server: server.url.origin, orgID: "org-alpha", orgName: "Alpha" },
                }),
              })

              yield* addPlugin()
              expect((yield* integrations.get(consoleID))?.connections[0]?.status).toMatchObject({
                status: "needs_auth",
                message: "Sign in with SSO again to use Alpha",
              })
              expect((yield* integrations.get(goID))?.connections[0]?.status).toBeUndefined()

              const rejected = (providerID: Provider.ID, message: string) =>
                hooks
                  .trigger("session", "http.response", {
                    sessionID: Session.ID.make("ses_go_error"),
                    agent: Agent.ID.make("build"),
                    model: Model.Ref.make({ providerID, id: Model.ID.make("glm-5.3") }),
                    kind: "primary",
                    request: new Request("https://opencode.ai/zen/go/v1/chat/completions"),
                    response: Response.json({ error: { message } }, { status: 403 }),
                  })
                  .pipe(Effect.flatMap((event) => Effect.promise(() => event.response.json())))

              expect(yield* rejected(goProviderID, "Invalid Go API key")).toEqual({
                error: { message: "Invalid Go API key" },
              })
              expect(yield* rejected(Provider.ID.opencode, "Workspace access denied")).toEqual({
                error: {
                  type: "authentication_error",
                  message: "Sign in with SSO again to use Alpha.",
                },
              })
            }),
          ({ server }) => Effect.promise(() => server.stop(true)),
        ),
      ),
    )

    it.live("keeps effective token, displayed account on both rows, and policy in sync across switching and disconnect", () =>
      withEnv({ OPENCODE_API_KEY: undefined }, () =>
        Effect.acquireUseRelease(
          Effect.sync(() => createGoServer()),
          ({ server, inferenceCalls, state }) =>
            Effect.gen(function* () {
              yield* seedGoCatalog(server.url.origin)
              const sudo: ConfigPolicy.Info = { action: "tool.use", resource: "shell:sudo *", effect: "deny" }
              const env: ConfigPolicy.Info = { action: "tool.use", resource: "edit:*.env", effect: "deny" }
              state.policies = { "org-alpha": [sudo], "org-beta": [env] }

              const credentials = yield* Credential.Service
              const integrations = yield* Integration.Service
              const managed = yield* ManagedPolicy.Service

              const alpha = yield* credentials.create({
                integrationID: consoleID,
                label: "Alpha",
                value: Credential.OAuth.make({
                  type: "oauth",
                  methodID: Integration.MethodID.make("device"),
                  access: "token-alpha",
                  refresh: "refresh-alpha",
                  expires: Date.now() + 600_000,
                  metadata: { server: server.url.origin, orgID: "org-alpha", orgName: "Alpha" },
                }),
              })

              yield* addPlugin()
              expect(managed.current()).toEqual({ statements: [sudo], organization: "Alpha" })

              const labels = (id: Integration.ID) =>
                integrations
                  .get(id)
                  .pipe(Effect.map((info) => info?.connections.map((c) => (c.type === "credential" ? c.label : c.name))))

              // Sign in to Beta from the Go row: stored under canonical `opencode` and becomes active on both rows.
              state.accessToken = "token-beta"
              state.refreshToken = "refresh-beta"
              state.orgID = "org-beta"
              state.orgName = "Beta"
              const attempt = yield* integrations.oauth.connect({
                integrationID: goID,
                methodID: Integration.MethodID.make("device"),
                answer: { server: server.url.origin },
              })
              yield* eventually(
                integrations.oauth.status({ integrationID: goID, attemptID: attempt.attemptID }),
                (current) => current.status === "complete",
              )
              yield* eventually(
                Effect.sync(() => managed.current().organization),
                (org) => org === "Beta",
              )
              expect(managed.current()).toEqual({ statements: [env], organization: "Beta" })
              expect(yield* labels(consoleID)).toEqual(["Beta", "Alpha"])
              expect(yield* labels(goID)).toEqual(["Beta", "Alpha"])

              yield* requestGo
              expect(inferenceCalls.at(-1)).toEqual({
                path: "/inference/go/openai/v1/chat/completions",
                authorization: "Bearer token-beta",
                orgID: "org-beta",
              })

              // Switch back to Alpha: both rows, policy, and Go inference switch together.
              yield* credentials.activate(alpha.id)
              yield* eventually(
                Effect.sync(() => managed.current().organization),
                (org) => org === "Alpha",
              )
              expect(managed.current()).toEqual({ statements: [sudo], organization: "Alpha" })
              expect((yield* labels(consoleID))?.[0]).toBe("Alpha")
              expect((yield* labels(goID))?.[0]).toBe("Alpha")

              yield* requestGo
              expect(inferenceCalls.at(-1)).toEqual({
                path: "/inference/go/openai/v1/chat/completions",
                authorization: "Bearer token-alpha",
                orgID: "org-alpha",
              })

              // Disconnect Alpha: falls back to Beta on both rows; disconnecting Beta signs out both rows.
              const betaID = required((yield* integrations.get(goID))?.connections[1])
              if (betaID.type !== "credential") throw new Error("Expected credential")
              yield* credentials.remove(alpha.id)
              yield* eventually(
                Effect.sync(() => managed.current().organization),
                (org) => org === "Beta",
              )
              expect(yield* labels(goID)).toEqual(["Beta"])

              yield* credentials.remove(betaID.id)
              yield* eventually(
                Effect.sync(() => managed.current().organization),
                (org) => org === undefined,
              )
              expect(managed.current()).toEqual({ statements: [], organization: undefined })
              expect((yield* integrations.get(consoleID))?.connections).toEqual([])
              expect((yield* integrations.get(goID))?.connections).toEqual([])
            }).pipe(Effect.provide(ModelResolver.layer)),
          ({ server }) => Effect.promise(() => server.stop(true)),
        ),
      ),
    )

    it.live(
      "preserves canonical active Console key ahead of inactive Console OAuth on the Go row and activates canonical OAuth when selected",
      () =>
        withEnv({ OPENCODE_API_KEY: undefined }, () =>
          Effect.acquireUseRelease(
            Effect.sync(() => createGoServer()),
            ({ server, inferenceCalls }) =>
              Effect.gen(function* () {
                yield* seedGoCatalog(server.url.origin)
                const credentials = yield* Credential.Service
                const integrations = yield* Integration.Service
                const providers = yield* Provider.Service

                // 1. Console OAuth account A, then Console service-account key B active; no dedicated Go key.
                const alpha = yield* credentials.create({
                  integrationID: consoleID,
                  label: "Alpha",
                  value: Credential.OAuth.make({
                    type: "oauth",
                    methodID: Integration.MethodID.make("device"),
                    access: "token-alpha",
                    refresh: "refresh-alpha",
                    expires: Date.now() + 600_000,
                    metadata: { server: server.url.origin, orgID: "org-alpha", orgName: "Alpha" },
                  }),
                })
                const betaKey = yield* credentials.create({
                  integrationID: consoleID,
                  label: "Beta Key",
                  value: Credential.Key.make({
                    type: "key",
                    key: "console-key-beta",
                    metadata: { server: server.url.origin, orgID: "org-beta" },
                  }),
                })

                yield* addPlugin()
                yield* eventually(
                  providers.get(goProviderID),
                  (provider) => provider?.integrationID === consoleID,
                )

                // Both rows preserve B (method: "key") as active [0] and inactive OAuth A as [1].
                const expectedOrder = [
                  { type: "credential" as const, id: betaKey.id, label: "Beta Key", method: "key" as const },
                  { type: "credential" as const, id: alpha.id, label: "Alpha", method: "oauth" as const },
                ]
                expect((yield* integrations.get(consoleID))?.connections).toEqual(expectedOrder)
                expect((yield* integrations.get(goID))?.connections).toEqual(expectedOrder)

                yield* requestGo
                expect(inferenceCalls.at(-1)).toEqual({
                  path: "/inference/go/openai/v1/chat/completions",
                  authorization: "Bearer console-key-beta",
                  orgID: "org-beta",
                })

                // 2. Selecting Alpha from the Go row really activates canonical Alpha on `opencode`.
                yield* integrations.connection.activate(alpha.id)
                yield* eventually(
                  Effect.map(integrations.get(goID), (info) => info?.connections[0]?.type === "credential" ? info.connections[0].id : undefined),
                  (id) => id === alpha.id,
                )
                expect((yield* integrations.get(consoleID))?.connections.map((c) => c.type === "credential" && c.label)).toEqual([
                  "Alpha",
                  "Beta Key",
                ])
                expect((yield* integrations.get(goID))?.connections.map((c) => c.type === "credential" && c.label)).toEqual([
                  "Alpha",
                  "Beta Key",
                ])

                yield* eventually(
                  Effect.sync(() => inferenceCalls.length),
                  () => true,
                )
                // Wait for OpencodePlugin to reload Alpha's config before requesting Go.
                yield* eventually(
                  providers.get(goProviderID),
                  (provider) => provider?.headers?.["x-opencode-org-id"] === "org-alpha",
                )
                yield* requestGo
                expect(inferenceCalls.at(-1)).toEqual({
                  path: "/inference/go/openai/v1/chat/completions",
                  authorization: "Bearer token-alpha",
                  orgID: "org-alpha",
                })

                // 3. Removing Alpha restores Beta Key as the active connection on both rows.
                yield* integrations.connection.remove(alpha.id)
                yield* eventually(
                  providers.get(goProviderID),
                  (provider) => provider?.headers?.["x-opencode-org-id"] === "org-beta",
                )
                expect((yield* integrations.get(goID))?.connections).toEqual([
                  { type: "credential", id: betaKey.id, label: "Beta Key", method: "key" },
                ])
                yield* requestGo
                expect(inferenceCalls.at(-1)).toEqual({
                  path: "/inference/go/openai/v1/chat/completions",
                  authorization: "Bearer console-key-beta",
                  orgID: "org-beta",
                })
              }).pipe(Effect.provide(ModelResolver.layer)),
            ({ server }) => Effect.promise(() => server.stop(true)),
          ),
        ),
    )

    it.live(
      "sends the canonical account token for an account-discovered opencode provider even when user config sets apiKey to public",
      () =>
        withEnv({ OPENCODE_API_KEY: undefined }, () =>
          Effect.acquireUseRelease(
            Effect.sync(() => createGoServer()),
            ({ server, inferenceCalls, state }) =>
              Effect.gen(function* () {
                state.consoleEntitled = true
                yield* seedGoCatalog(server.url.origin)

                const credentials = yield* Credential.Service
                const providers = yield* Provider.Service
                const plugin = yield* Plugin.Service

                yield* credentials.create({
                  integrationID: consoleID,
                  label: "Alpha",
                  value: Credential.OAuth.make({
                    type: "oauth",
                    methodID: Integration.MethodID.make("device"),
                    access: "token-alpha",
                    refresh: "refresh-alpha",
                    expires: Date.now() + 600_000,
                    metadata: { server: server.url.origin, orgID: "org-alpha", orgName: "Alpha" },
                  }),
                })

                const host = yield* PluginHost.make(plugin)
                yield* OpencodePlugin.effect(host)
                // User config sets providers.opencode.settings.apiKey = "public" after OpencodePlugin discovers `opencode`.
                yield* ConfigProviderPlugin.Plugin.effect(host).pipe(
                  Effect.provide(
                    Config.testLayer([
                      new Document({
                        type: "document",
                        info: Schema.decodeUnknownSync(ConfigInfo)({
                          providers: {
                            opencode: {
                              settings: { apiKey: "public" },
                            },
                          },
                        }),
                      }),
                    ]),
                  ),
                )

                yield* eventually(
                  providers.get(Provider.ID.opencode),
                  (provider) =>
                    provider?.integrationID === consoleID && provider?.settings?.apiKey === "public",
                )

                const resolver = yield* ModelResolver.Service
                const resolved = required(
                  yield* resolver.resolve(
                    Model.Ref.make({ providerID: Provider.ID.opencode, id: Model.ID.make("paid-zen") }),
                  ),
                )
                yield* LLMClient.stream(LLM.request({ model: resolved.model, prompt: "hello" })).pipe(
                  Stream.runDrain,
                  Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer))),
                )

                expect(inferenceCalls).toEqual([
                  {
                    path: "/inference/zen/openai/v1/chat/completions",
                    authorization: "Bearer token-alpha",
                    orgID: "org-alpha",
                  },
                ])
              }).pipe(Effect.provide(ModelResolver.layer)),
            ({ server }) => Effect.promise(() => server.stop(true)),
          ),
        ),
    )
  })
})

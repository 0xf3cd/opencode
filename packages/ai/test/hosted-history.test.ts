import { expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM, Message, ToolCallPart, ToolResultPart, type LanguageModel } from "../src/index.js"
import {
  AnthropicMessages,
  BedrockConverse,
  CohereChat,
  Gemini,
  GoogleInteractions,
  MistralChat,
  OpenAIChat,
} from "../src/protocols.js"
import { ProviderShared } from "../src/protocols/shared.js"
import { Auth } from "../src/route.js"
import { compileRequest } from "../src/route/client.js"
import { it } from "./lib/effect.js"

const models = [
  OpenAIChat.route.with({ endpoint: { baseURL: "https://provider.test/" }, auth: Auth.none }).model({ id: "gpt-4o" }),
  AnthropicMessages.route
    .with({ endpoint: { baseURL: "https://provider.test/" }, auth: Auth.none })
    .model({ id: "claude-sonnet-4-5" }),
  Gemini.route
    .with({ endpoint: { baseURL: "https://provider.test/" }, auth: Auth.none })
    .model({ id: "gemini-2.5-flash" }),
  BedrockConverse.route
    .with({ endpoint: { baseURL: "https://provider.test/" }, auth: Auth.none })
    .model({ id: "amazon.nova-pro-v1:0" }),
  MistralChat.route
    .with({ endpoint: { baseURL: "https://provider.test/" }, auth: Auth.none })
    .model({ id: "mistral-large-latest" }),
  CohereChat.route
    .with({ endpoint: { baseURL: "https://provider.test/" }, auth: Auth.none })
    .model({ id: "command-a-03-2025" }),
  GoogleInteractions.route
    .with({ endpoint: { baseURL: "https://provider.test/" }, auth: Auth.none })
    .model({ id: "gemini-3-flash-preview" }),
]

const call = ToolCallPart.make({
  id: "hosted_1",
  name: "foreign_search",
  input: { query: "otters" },
  providerExecuted: true,
  providerMetadata: { foreign: { opaque: "DO_NOT_REPLAY" } },
})
const result = ToolResultPart.make({
  id: call.id,
  name: call.name,
  providerExecuted: true,
  result: { type: "text", value: "Otters use rocks." },
  providerMetadata: call.providerMetadata,
})

const compile = (model: LanguageModel, messages: ReadonlyArray<Message>) =>
  compileRequest(
    LLM.request({
      model,
      messages,
      cache: "none",
    }),
  )

it.effect("OpenAI Chat separates hosted fallback entries from surrounding assistant text", () =>
  Effect.gen(function* () {
    const prepared = yield* compile(models[0], [
      Message.user("Search."),
      Message.assistant([Message.text("Before."), call, result, Message.text("After.")]),
      Message.user("Continue."),
    ])
    expect(prepared.body.messages).toMatchObject([
      { role: "user" },
      {
        role: "assistant",
        content:
          'Before.\nProvider tool foreign_search called with: {"query":"otters"}\n\nProvider tool foreign_search returned:\nOtters use rocks.\nAfter.',
      },
      { role: "user" },
    ])
  }),
)

for (const model of models) {
  it.effect(`${model.route.id} degrades foreign hosted history without dangling tool calls`, () =>
    Effect.gen(function* () {
      const prepared = yield* compile(model, [
        Message.user("Search."),
        Message.assistant([Message.text("Before."), call, result, Message.text("After.")]),
        Message.user("Continue."),
      ])
      const body = ProviderShared.encodeJson(prepared.body)
      expect(body).toContain("Otters use rocks.")
      expect(body).toContain("foreign_search")
      expect(body).toContain("otters")
      expect(body).toContain("Before.")
      expect(body).toContain("After.")
      expect(body).not.toContain("DO_NOT_REPLAY")
      expect(body).not.toContain("hosted_1")
    }),
  )

  it.effect(`${model.route.id} preserves a failed hosted tool's error`, () =>
    Effect.gen(function* () {
      const prepared = yield* compile(model, [
        Message.user("Search."),
        Message.assistant([
          call,
          ToolResultPart.make({ ...result, result: { type: "error", value: { error: "Search timed out" } } }),
        ]),
        Message.user("Continue."),
      ])
      const body = ProviderShared.encodeJson(prepared.body)
      expect(body).toContain("Search timed out")
      expect(body).not.toContain("hosted_1")
    }),
  )

  it.effect(`${model.route.id} preserves hosted images alongside ordinary local tools`, () =>
    Effect.gen(function* () {
      const prepared = yield* compile(model, [
        Message.user("Search."),
        Message.assistant([
          call,
          ToolResultPart.make({
            ...result,
            result: {
              type: "content",
              value: [
                { type: "text", text: "An otter." },
                { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png" },
              ],
            },
          }),
          ToolCallPart.make({ id: "local_1", name: "read", input: {} }),
        ]),
        Message.tool({ id: "local_1", name: "read", result: "local answer" }),
        Message.user("Continue."),
      ])
      const body = ProviderShared.encodeJson(prepared.body)
      expect(body).toContain("An otter.")
      expect(body).toContain("aGVsbG8=")
      expect(body).toContain("local answer")
      expect(body).not.toContain("hosted_1")
    }),
  )
}

it.effect("Anthropic preserves its native server-tool blocks", () =>
  Effect.gen(function* () {
    const payload = [{ type: "web_search_result", url: "https://example.com", encrypted_content: "encrypted" }]
    const prepared = yield* compile(models[1], [
      Message.user("Search."),
      Message.assistant([
        ToolCallPart.make({ ...call, name: "web_search", providerMetadata: undefined }),
        ToolResultPart.make({
          ...result,
          name: "web_search",
          providerMetadata: { anthropic: { blockType: "web_search_tool_result", result: payload } },
        }),
      ]),
      Message.user("Continue."),
    ])
    expect(prepared.body.messages).toMatchObject([
      { role: "user" },
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: call.id },
          { type: "web_search_tool_result", tool_use_id: call.id, content: payload },
        ],
      },
      { role: "user" },
    ])
  }),
)

it.effect("Anthropic degrades a known tool name without a native result payload", () =>
  Effect.gen(function* () {
    const prepared = yield* compile(models[1], [
      Message.user("Search."),
      Message.assistant([
        ToolCallPart.make({ ...call, name: "web_search", providerMetadata: undefined }),
        ToolResultPart.make({ ...result, name: "web_search", providerMetadata: undefined }),
      ]),
      Message.user("Continue."),
    ])
    const body = ProviderShared.encodeJson(prepared.body)
    expect(body).toContain("Otters use rocks.")
    expect(body).not.toContain("server_tool_use")
    expect(body).not.toContain("web_search_tool_result")
  }),
)

for (const [name, payload] of [
  ["code_execution", { type: "code_execution_result", stdout: "ok", stderr: "", return_code: 0, content: [] }],
  ["code_execution", { type: "encrypted_code_execution_result", encrypted_stdout: "encrypted", content: [] }],
  ["web_fetch", { type: "web_fetch_result", url: "https://example.com", content: {} }],
  ["web_fetch", { type: "web_fetch_tool_result_error", error_code: "unavailable" }],
] as const) {
  it.effect(`Anthropic preserves direct ${payload.type} without replay metadata`, () =>
    Effect.gen(function* () {
      const prepared = yield* compile(models[1], [
        Message.assistant([
          ToolCallPart.make({ ...call, name, providerMetadata: undefined }),
          ToolResultPart.make({
            ...result,
            name,
            result: { type: "json", value: payload },
            providerMetadata: undefined,
          }),
        ]),
        Message.user("Continue."),
      ])
      expect(prepared.body.messages).toMatchObject([
        {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: call.id, name },
            { type: `${name}_tool_result`, tool_use_id: call.id, content: payload },
          ],
        },
        { role: "user" },
      ])
    }),
  )
}

it.effect("Anthropic does not treat a foreign JSON search item as a native result block", () =>
  Effect.gen(function* () {
    const prepared = yield* compile(models[1], [
      Message.assistant([
        ToolCallPart.make({ ...call, name: "web_search" }),
        ToolResultPart.make({
          ...result,
          name: "web_search",
          result: { type: "json", value: { type: "web_search_call", id: "ws_1", status: "completed" } },
        }),
      ]),
      Message.user("Continue."),
    ])
    const body = ProviderShared.encodeJson(prepared.body)
    expect(body).toContain("ws_1")
    expect(body).not.toContain("web_search_tool_result")
  }),
)

test("fallback leaves local tools unchanged and hoists hosted media after local answers", () => {
  const local = ToolCallPart.make({ id: "local_1", name: "read", input: {} })
  const answer = Message.tool({ id: local.id, name: local.name, result: "local answer" })
  const history = ProviderShared.hostedToolHistory([
    Message.assistant([
      call,
      ToolResultPart.make({
        ...result,
        result: {
          type: "content",
          value: [
            { type: "text", text: "An image." },
            { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png" },
          ],
        },
      }),
      local,
    ]),
    answer,
    Message.user("Continue."),
  ])
  expect(history.map((message) => message.role)).toEqual(["assistant", "tool", "user", "user"])
  expect(history[0].content.at(-1)).toEqual(local)
  expect(history[1]).toBe(answer)
  expect(history[2].content[0]).toMatchObject({ type: "media", media: { mediaType: "image/png" } })
})

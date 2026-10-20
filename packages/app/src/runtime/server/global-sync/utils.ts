import type { AgentListOutput, ModelListOutput, ProviderListOutput } from "@opencode/client/promise"
import type { Agent, Project, Provider, ProviderListResponse } from "@/runtime/server/types"
import type { Project as CurrentProject } from "@opencode/client/promise"
import type { ServerConnection } from "@/runtime/server/registry"
import { unwrap } from "solid-js/store"

export { pathKey as directoryKey, type PathKey as DirectoryKey } from "@/workspaces/path-key"

const providerCatalogs = new WeakMap<
  ProviderListOutput["data"],
  WeakMap<ModelListOutput["data"], ProviderListResponse>
>()

export function normalizeAgentList(input: AgentListOutput["data"] | Agent[]): Agent[] {
  if (input.every((agent) => !("request" in agent))) return input as Agent[]

  return (input as AgentListOutput["data"]).map((agent) => ({
    name: agent.id,
    description: agent.description,
    mode: agent.mode,
    hidden: agent.hidden,
    temperature:
      typeof agent.request.settings.temperature === "number" ? agent.request.settings.temperature : undefined,
    topP: typeof agent.request.settings.topP === "number" ? agent.request.settings.topP : undefined,
    color: agent.color,
    permission: agent.permissions.map((rule) => ({
      permission: rule.action,
      pattern: rule.resource,
      action: rule.effect,
    })),
    model: agent.model && { providerID: agent.model.providerID, modelID: agent.model.id },
    variant: agent.model?.variant,
    prompt: agent.system,
    options: agent.request.settings,
    steps: agent.steps,
  }))
}

export function normalizeProviderList(
  input: ProviderListOutput["data"] | ProviderListResponse,
  catalog?: ModelListOutput["data"],
): ProviderListResponse {
  if (!Array.isArray(input)) return input
  // Client sync replaces whole catalog lists. Track those reads at the caller,
  // not every model field, and share conversions without retaining old lists.
  const providers = unwrap(input)
  const models = unwrap(catalog)
  const cached = models && providerCatalogs.get(providers)?.get(models)

  if (cached) return cached
  const all = new Map<string, Provider>()

  for (const provider of providers) {
    all.set(provider.id, {
      id: provider.id,
      canonical: provider.canonical,
      integrationID: provider.integrationID,
      name: provider.name,
      source: "custom",
      env: [],
      options: provider.settings ?? {},
      models: {},
    })
  }

  for (const model of models ?? []) {
    const provider = all.get(model.providerID)

    if (!provider || model.status === "deprecated") continue
    const cost = model.cost.find((item) => item.tier === undefined) ?? model.cost[0]
    provider.models[model.id] = {
      id: model.id,
      providerID: model.providerID,
      api: {
        id: model.modelID,
        url: "",
        npm: model.package ?? provider.id,
      },
      name: model.name,
      family: model.family,
      capabilities: {
        temperature: false,
        reasoning: false,
        attachment: model.capabilities.input.some((item) => item !== "text"),
        toolcall: model.capabilities.tools,
        input: {
          text: model.capabilities.input.includes("text"),
          audio: model.capabilities.input.includes("audio"),
          image: model.capabilities.input.includes("image"),
          video: model.capabilities.input.includes("video"),
          pdf: model.capabilities.input.includes("pdf"),
        },
        output: {
          text: model.capabilities.output.includes("text"),
          audio: model.capabilities.output.includes("audio"),
          image: model.capabilities.output.includes("image"),
          video: model.capabilities.output.includes("video"),
          pdf: model.capabilities.output.includes("pdf"),
        },
        interleaved: false,
      },
      cost: {
        input: cost?.input ?? 0,
        output: cost?.output ?? 0,
        cache: {
          read: cost?.cache.read ?? 0,
          write: cost?.cache.write ?? 0,
        },
      },
      limit: model.limit,
      status: model.status,
      options: model.settings ?? {},
      headers: model.headers ?? {},
      release_date: new Date(model.time.released).toISOString().slice(0, 10),
      variants: Object.fromEntries(model.variants.map((variant) => [variant.id, variant.settings ?? {}])),
    }
  }

  const result = {
    all,
    connected: providers.map((provider) => provider.id),
    default: Object.fromEntries(
      providers.flatMap((provider) => {
        const model = models?.find((item) => item.providerID === provider.id && item.status !== "deprecated")

        return model ? [[provider.id, model.id]] : []
      }),
    ),
  }

  if (models) {
    const cache = providerCatalogs.get(providers) ?? new WeakMap<ModelListOutput["data"], ProviderListResponse>()
    cache.set(models, result)
    providerCatalogs.set(providers, cache)
  }

  return result
}

export type ProjectIconHttp = ServerConnection.HttpBase & {
  readonly icon?: (input: { projectID: string; v?: string }) => Promise<Uint8Array>
  readonly onIcon?: (projectID: string, url: string) => void
}

const iconBlobs = new Map<string, string>()

function resolveProjectIcon(projectID: string, icon: CurrentProject["icon"], http?: ProjectIconHttp) {
  const raw = icon?.url
  const key = raw?.startsWith("/") && http?.url && http.password ? `${http.url}${raw}` : undefined
  const prefix = http?.url ? `${http.url}/api/project/${encodeURIComponent(projectID)}/icon` : undefined
  if (prefix) {
    for (const [k, blob] of iconBlobs) {
      if (k !== key && k.startsWith(prefix)) {
        if (blob) URL.revokeObjectURL(blob)
        iconBlobs.delete(k)
      }
    }
  }
  if (!raw?.startsWith("/")) return icon
  if (!http?.url) return { ...icon, url: undefined }
  if (!http.password) return { ...icon, url: new URL(raw, http.url).toString() }
  const cached = key ? iconBlobs.get(key) : undefined
  if (key && !iconBlobs.has(key) && http.icon) {
    iconBlobs.set(key, "")
    const v = new URL(raw, http.url).searchParams.get("v") ?? undefined
    void http
      .icon({ projectID, v })
      .then((bytes) => {
        const blob = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], bytes[0] === 0x3c ? { type: "image/svg+xml" } : undefined),
        )
        if (iconBlobs.get(key) !== "") return URL.revokeObjectURL(blob)
        iconBlobs.set(key, blob)
        http.onIcon?.(projectID, blob)
      })
      .catch(() => undefined)
  }
  return { ...icon, url: cached || undefined }
}

export function normalizeProjectInfo(project: Project | CurrentProject, http?: ProjectIconHttp): Project {
  const worktree = "canonical" in project ? project.canonical : project.worktree

  return {
    ...project,
    icon: resolveProjectIcon(project.id, project.icon, http),
    worktree,
    worktrees: "worktrees" in project ? project.worktrees : [{ directory: worktree }],
  }
}

export function updateProjectInfo(project: Project, update: CurrentProject, http?: ProjectIconHttp): Project {
  return {
    ...project,
    ...update,
    icon: resolveProjectIcon(update.id, update.icon, http),
    worktree: update.canonical,
    worktrees: project.worktrees,
  }
}

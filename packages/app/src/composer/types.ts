import type {
  AgentPart,
  ComposerStore,
  FileAttachmentPart,
  ImageAttachmentPart,
  PathAttachmentPart,
  Prompt,
  PromptHistoryComment,
  SessionPart,
  SkillPart,
} from "./state"

export type ComposerFilePart = FileAttachmentPart

export type ComposerAgentPart = AgentPart

export type ComposerSkillPart = SkillPart

export type ComposerSessionPart = SessionPart

export type ComposerAttachment = ImageAttachmentPart | PathAttachmentPart

export type ComposerPrompt = Prompt

export type ComposerComment = ComposerStore["context"]["items"][number]

export type ComposerPersistedState = ComposerStore

export type ComposerHistoryEntry = {
  prompt: ComposerPrompt
  metadata?: PromptHistoryComment[]
}

export type ComposerHistory = {
  entries: (mode: "normal" | "shell") => ComposerHistoryEntry[]
  add: (prompt: ComposerPrompt, mode: "normal" | "shell") => void
  capture?: () => PromptHistoryComment[]
  restore?: (metadata: PromptHistoryComment[] | undefined) => void
}

export type ComposerOption = {
  id: string
  label: string
  providerID?: string
}

export type ComposerSuggestion = {
  id: string
  kind: "agent" | "command" | "file" | "reference" | "resource" | "session" | "skill"
  label: string
  title?: string
  trigger?: string
  description?: string
  path?: string
  keybind?: string[]
  recent?: boolean
  mention?: ComposerFilePart | ComposerAgentPart | ComposerSkillPart | ComposerSessionPart
}

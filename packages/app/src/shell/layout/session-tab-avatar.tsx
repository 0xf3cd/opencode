import type { LocalProject } from "@/shell/state/layout"
import type { ServerConnection } from "@/runtime/server/registry"
import { useSessionTabAvatarState } from "@/shell/layout/project-avatar-state"
import {
  displayName,
  getProjectAvatarSource,
  getProjectAvatarVariant,
  ProjectAvatar,
} from "@opencode/ui/project-avatar"
import { SessionProgressIndicatorV2 } from "@opencode/session-ui/v2/session-progress-indicator-v2"
import { AgentOrb, type AgentOrbState } from "@opencode/session-ui/v2/agent-orb"
import { Match, Switch } from "solid-js"

export function SessionTabAvatar(props: {
  project?: LocalProject
  directory: string
  sessionId: string
  server: ServerConnection.Key
}) {
  const state = useSessionTabAvatarState(
    () => props.server,
    () => props.sessionId,
    () => true,
  )

  return (
    <SessionTabAvatarView
      project={props.project}
      directory={props.directory}
      unread={state.unread()}
      loading={state.loading()}
      activity={state.activity()}
    />
  )
}

export function SessionTabAvatarView(props: {
  project?: LocalProject
  directory: string
  unread: boolean
  loading?: boolean
  // Set when the orb style is on; idle shows the project avatar.
  activity?: AgentOrbState
}) {
  return (
    <Switch
      fallback={
        <ProjectAvatar
          fallback={displayName(props.project ?? { worktree: props.directory })}
          src={getProjectAvatarSource(props.project?.id, props.project?.icon)}
          variant={getProjectAvatarVariant(props.project?.icon?.color)}
          unread={props.unread}
        />
      }
    >
      <Match when={props.activity !== undefined && props.activity !== "idle"}>
        <AgentOrb state={props.activity ?? "idle"} />
      </Match>
      <Match when={props.activity === undefined && props.loading}>
        <SessionProgressIndicatorV2 />
      </Match>
    </Switch>
  )
}

// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// Every field is plain JSON (null, never undefined): panel replies must be plain JSON.
export {}

/** One port a service declares, as `devtrees ls --json` reports it. */
export interface PortView {
  name: string
  port: number
}

/** One service row of a stack. */
export interface ServiceView {
  name: string
  /** process-compose's own status, such as `Running` or `Completed`. */
  status: string
  /** devtrees' reading of it: `active`, `dead` or `done`. */
  state: 'active' | 'dead' | 'done'
  health: 'ready' | 'not_ready' | 'unknown'
  tier: 'isolated' | 'shared'
  ports: PortView[]
}

/** One process-compose instance: a worktree's, or the shared one. */
export interface InstanceView {
  /** `up`: every service runs; `partial`: some are dead; `unknown`: the instance did not answer. */
  status: 'up' | 'partial' | 'down' | 'unknown'
  id: string
  namespaces: string[]
  services: ServiceView[]
}

export interface WorkspaceRef {
  id: string
  name: string
  path: string
  /** Without `refs/heads/`; null for a folder or a detached head. */
  branch: string | null
  /** The repository's display name, when Orca sends it (1.4.256 and newer). */
  project: string | null
}

export type StackAction = 'up' | 'down' | 'restart' | 'restart-service'

export interface Busy {
  action: StackAction
  service: string | null
  since: number
}

export interface ActionError {
  action: StackAction
  code: string
  message: string
  at: number
}

/** One worktree with a devtrees.yaml: a row of the panel. */
export interface RowView {
  workspace: WorkspaceRef
  /** Its instance; null when its repo could not be read (see `RepoView.message`). */
  stack: InstanceView | null
  busy: Busy | null
  lastError: ActionError | null
}

/** The rows of one repository, keyed by its git common dir. */
export interface RepoView {
  /** The git common dir; a worktree's own path when git could not name one. */
  key: string
  /** Orca's project name, else the main checkout's folder name. */
  label: string
  /** `error`: `devtrees ls` failed in this repo; `message` says why. */
  kind: 'ok' | 'error'
  message: string | null
  rows: RowView[]
  /** The repo's shared instance; null when it is not running or could not be read. */
  shared: InstanceView | null
}

export interface StackView {
  /**
   * `ok`: `repos` holds every local worktree with a devtrees.yaml; empty when there is none.
   * `not-installed`: the devtrees executable was not found. `too-old`: it lacks `ls --services`.
   */
  kind: 'ok' | 'not-installed' | 'too-old'
  repos: RepoView[]
  /**
   * The workspace id of the focused row, only when Orca's context names one worktree for
   * certain. Used to highlight it, never to choose where an action runs.
   */
  focusedId: string | null
  /** The orca CLI could not be run, and focus did not resolve without it. */
  focusUnknown: boolean
  /** The executable the worker runs, from the plugin settings. */
  executable: string
}

declare module 'orca' {
  interface PluginRequests {
    /** Every row and its stack, read fresh. */
    'stack.get': { input: { refresh?: boolean }; output: StackView }
    /**
     * Starts an action in the background in the given workspace's path; `stack.changed`
     * reports its progress and result.
     */
    'stack.action': {
      input: { workspaceId: string; action: StackAction; service?: string }
      output: { started: boolean; reason: string | null }
    }
  }
  interface PluginPanelEvents {
    'stack.changed': StackView
  }
}

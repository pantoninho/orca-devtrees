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

/** One process-compose instance: this worktree's, or the shared one. */
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
}

export type StackAction = 'up' | 'down' | 'restart' | 'restart-service'

export interface StackView {
  /**
   * `no-workspace`: nothing focused, or not a local worktree. `no-config`: no devtrees.yaml.
   * `not-installed`: the devtrees executable was not found. `too-old`: it lacks `ls --services`.
   * `error`: devtrees failed; `message` says why. `ok`: `stack` and `shared` hold the stack.
   */
  kind: 'no-workspace' | 'no-config' | 'not-installed' | 'too-old' | 'error' | 'ok'
  workspace: WorkspaceRef | null
  /** Workspaces the focused one could be, when Orca's context matches more than one. */
  candidates: WorkspaceRef[]
  message: string | null
  stack: InstanceView | null
  shared: InstanceView | null
  busy: { action: StackAction; service: string | null; since: number } | null
  lastError: { action: StackAction; code: string; message: string; at: number } | null
  /** The executable the worker runs, from the plugin settings. */
  executable: string
}

declare module 'orca' {
  interface PluginRequests {
    /** The focused worktree's stack, read fresh. */
    'stack.get': { input: { refresh?: boolean }; output: StackView }
    /** Starts an action in the background; `stack.changed` reports its progress and result. */
    'stack.action': {
      input: { action: StackAction; service?: string }
      output: { started: boolean; reason: string | null }
    }
    /** Picks one of `candidates` as the focused worktree. */
    'workspace.pick': { input: { workspaceId: string }; output: StackView }
  }
  interface PluginPanelEvents {
    'stack.changed': StackView
  }
}

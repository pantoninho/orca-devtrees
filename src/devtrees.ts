// Talking to the devtrees CLI: what to run, and how to read what it prints.
// Pure functions over a `Runner`, so tests replace the CLI with a stub.
import type { InstanceView, PortView, ServiceView, StackView } from './protocol'

/** Oldest devtrees with `ls --services` and `restart`. */
export const MIN_DEVTREES_VERSION = '0.1.0'

export interface RunResult {
  /** Exit code; null when the process could not start or was killed. */
  code: number | null
  stdout: string
  stderr: string
  /** The executable was not found (ENOENT). */
  notFound: boolean
}

export interface RunOptions {
  cwd: string
  /**
   * Run in its own process group, so the command finishes even if the worker restarts
   * meanwhile (every save of the plugin restarts it). Used for commands that change state.
   */
  detached?: boolean
}

/** Everything the worker needs from the machine. */
export interface Runner {
  run(executable: string, args: string[], options: RunOptions): Promise<RunResult>
  /** Whether a file exists. */
  exists(path: string): Promise<boolean>
  /** `realpath`, or the path itself when it cannot be resolved. */
  realpath(path: string): Promise<string>
  /** Hex sha256 of a string. */
  sha256(text: string): string
}

/** A devtrees `--json` error envelope's `error`. */
export interface DevtreesError {
  code: string
  message: string
}

export type Failure =
  | { kind: 'not-installed' }
  | { kind: 'too-old' }
  | { kind: 'error'; code: string; message: string }

/**
 * The worktree id devtrees derives from a worktree's path: a slug of the basename plus 8 hex
 * chars of the path's sha256. Mirrors `deriveWorktreeId` in devtrees' src/anchor.ts, so the
 * panel finds this worktree's instance in `ls` without running a command that allocates ports.
 */
export function worktreeIdOf(root: string, sha256: (text: string) => string): string {
  const normalized = root.replace(/[/\\]+$/, '')
  const base = normalized.split(/[/\\]/).pop() ?? ''
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug === '' ? 'wt' : slug}-${sha256(normalized).slice(0, 8)}`
}

/** Reads a failed run: missing executable, too old, or the JSON error envelope. */
export function failureOf(result: RunResult): Failure {
  if (result.notFound) return { kind: 'not-installed' }
  const text = `${result.stdout}\n${result.stderr}`
  if (/Unsupported option name|Command not found/.test(text)) return { kind: 'too-old' }
  const envelope = parseJson(result.stdout)
  const error = envelope?.error
  if (isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string') {
    return { kind: 'error', code: error.code, message: error.message }
  }
  const message = (result.stderr || result.stdout).trim().split('\n')[0] || 'devtrees failed'
  return { kind: 'error', code: 'UNKNOWN', message: message.replace(/^devtrees: /, '') }
}

export function parseJson(text: string): Record<string, unknown> | null {
  const line = text
    .trim()
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('{'))
  if (line === undefined) return null
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function portsOf(raw: unknown): PortView[] {
  if (!isRecord(raw)) return []
  return Object.entries(raw)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([name, port]) => ({ name, port }))
}

function serviceOf(raw: unknown): ServiceView | null {
  if (!isRecord(raw) || typeof raw.name !== 'string') return null
  const state = raw.state === 'dead' || raw.state === 'done' ? raw.state : 'active'
  const health = raw.health === 'ready' || raw.health === 'not_ready' ? raw.health : 'unknown'
  return {
    name: raw.name,
    status: typeof raw.status === 'string' ? raw.status : 'unknown',
    state,
    health,
    tier: raw.tier === 'shared' ? 'shared' : 'isolated',
    ports: portsOf(raw.ports)
  }
}

function instanceOf(raw: Record<string, unknown>): InstanceView {
  const services = (Array.isArray(raw.services) ? raw.services : [])
    .map(serviceOf)
    .filter((s): s is ServiceView => s !== null)
  const namespaces = Array.isArray(raw.namespaces)
    ? raw.namespaces.filter((n): n is string => typeof n === 'string')
    : []
  let status: InstanceView['status']
  if (raw.status === 'stale') status = 'down'
  else if (raw.status !== 'running' || raw.services_read === 'unresponsive') status = 'unknown'
  else status = services.some((s) => s.state === 'dead') ? 'partial' : 'up'
  return { status, id: typeof raw.id === 'string' ? raw.id : '', namespaces, services }
}

/** Picks this worktree's instance and the shared one out of `ls --services --json`. */
export function readLs(
  stdout: string,
  worktreeId: string
): { stack: InstanceView; shared: InstanceView | null } | null {
  const ls = parseJson(stdout)?.ls
  if (!isRecord(ls) || !Array.isArray(ls.instances)) return null
  const instances = ls.instances.filter(isRecord)
  const own = instances.find((i) => i.kind === 'worktree' && i.id === worktreeId)
  const shared = instances.find((i) => i.kind === 'shared')
  return {
    stack: own
      ? instanceOf(own)
      : { status: 'down', id: worktreeId, namespaces: [], services: [] },
    shared: shared ? instanceOf(shared) : null
  }
}

/** The arguments of each stack action. */
export const args = {
  ls: ['ls', '--services', '--json'],
  up: (namespaces: string[] = []) => [
    'up',
    ...namespaces.flatMap((n) => ['-n', n]),
    '--no-attach',
    '--json'
  ],
  down: ['down', '--json'],
  restart: (service: string) => ['restart', service, '--json'],
  prune: ['prune', '--json']
}

export interface StatusBarState {
  visible: boolean
  text: string
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  tooltip: string
}

const BUSY_WORDS = {
  up: 'starting',
  down: 'stopping',
  restart: 'restarting',
  'restart-service': 'restarting'
} as const

/** The status bar item for a view, such as `devtrees: up · web :41230`. */
export function statusBarOf(view: StackView): StatusBarState {
  const hidden = { visible: false, text: 'devtrees', tone: 'neutral', tooltip: 'devtrees' } as const
  if (view.kind === 'no-workspace' || view.kind === 'no-config') return hidden
  if (view.kind === 'not-installed') {
    return { visible: true, text: 'devtrees: not found', tone: 'warning', tooltip: `${view.executable} was not found` }
  }
  if (view.kind === 'too-old') {
    return {
      visible: true,
      text: 'devtrees: upgrade',
      tone: 'warning',
      tooltip: `devtrees ${MIN_DEVTREES_VERSION} or newer is needed`
    }
  }
  if (view.busy !== null) {
    const what = view.busy.service === null ? '' : ` ${view.busy.service}`
    return { visible: true, text: `devtrees: ${BUSY_WORDS[view.busy.action]}${what}`, tone: 'accent', tooltip: 'devtrees is working' }
  }
  if (view.kind === 'error' || view.stack === null) {
    return { visible: true, text: 'devtrees: error', tone: 'danger', tooltip: view.message ?? 'devtrees failed' }
  }
  const stack = view.stack
  const tooltip = `Stack ${stack.id}. Press to toggle the Ports sidebar.`
  if (stack.status === 'down') return { visible: true, text: 'devtrees: down', tone: 'neutral', tooltip }
  if (stack.status === 'unknown') return { visible: true, text: 'devtrees: not answering', tone: 'warning', tooltip }
  if (stack.status === 'partial') {
    const dead = stack.services.filter((s) => s.state === 'dead').map((s) => s.name)
    return { visible: true, text: `devtrees: ${dead.length} dead · ${dead.join(', ')}`, tone: 'danger', tooltip }
  }
  const first = stack.services.find((s) => s.ports.length > 0)
  const port = first ? ` · ${first.name} :${first.ports[0].port}` : ''
  return { visible: true, text: `devtrees: up${port}`, tone: 'success', tooltip }
}

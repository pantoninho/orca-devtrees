// What the panel shows, as pure functions of the view: status dots, the order of rows, and short
// port labels. Kept apart from src/panel.tsx so tests read them without drawing.
import type { InstanceView, PortView, RepoView, RowView, ServiceView, StackView } from './protocol'

/** A status dot's color: green, amber, red or grey. */
export type Dot = 'success' | 'warning' | 'danger' | 'neutral'

/** Green: running and healthy. Amber: starting, or running with unknown health. Red: dead. Grey: stopped. */
export function serviceDot(service: ServiceView): Dot {
  if (service.state === 'dead') return 'danger'
  if (service.state === 'done') return 'neutral'
  return service.health === 'ready' ? 'success' : 'warning'
}

/** A worktree row's dot, from its action, last error and stack. */
export function rowDot(row: RowView): Dot {
  if (row.busy !== null) return 'warning'
  if (row.lastError !== null || row.stack === null) return 'danger'
  return instanceDot(row.stack)
}

export function instanceDot(instance: InstanceView): Dot {
  if (instance.status === 'down') return 'neutral'
  if (instance.status === 'partial') return 'danger'
  if (instance.status === 'unknown') return 'warning'
  return 'success'
}

const BUSY_WORD = { up: 'starting', down: 'stopping', restart: 'restarting', 'restart-service': 'restarting' } as const

/**
 * The few words a collapsed row adds after its name, or null when the dot says it all: what it
 * is doing, what failed, how many services are dead, or that the instance does not answer.
 */
export function rowNote(row: RowView): string | null {
  if (row.busy !== null) return BUSY_WORD[row.busy.action]
  if (row.lastError !== null) return `${row.lastError.action} failed`
  if (row.stack === null) return 'unreadable'
  if (row.stack.status === 'partial') return `${row.stack.services.filter((s) => s.state === 'dead').length} dead`
  if (row.stack.status === 'unknown') return 'not answering'
  return null
}

/** Folded into the "N stopped" line: down, idle, without an error, and not focused. */
export function isFolded(row: RowView, focusedId: string | null): boolean {
  return (
    row.workspace.id !== focusedId &&
    row.busy === null &&
    row.lastError === null &&
    row.stack !== null &&
    row.stack.status === 'down'
  )
}

/** What a worktree is called in the panel: its branch, else its Orca name. */
export const nameOf = (row: RowView): string => row.workspace.branch ?? row.workspace.name

/** A worktree and the repo it belongs to. */
export interface Placed {
  repo: RepoView
  row: RowView
}

/** One line of the list below the focused worktree. */
export type ListEntry = ({ kind: 'row' } & Placed) | { kind: 'shared'; repo: RepoView }

/**
 * The panel's three parts: the focused worktree, only when focus is known; the other stacks that
 * run (or are busy, failed or unreadable), each repo's rows followed by its running shared
 * instance; and the stopped rows, folded into one line. The focused repo's shared instance is
 * not listed: the focused worktree already shows its services.
 */
export function layoutOf(v: StackView): { focused: Placed | null; running: ListEntry[]; stopped: Placed[] } {
  const focusedId = v.focusUnknown ? null : v.focusedId
  let focused: Placed | null = null
  const running: ListEntry[] = []
  const stopped: Placed[] = []
  for (const repo of v.repos) {
    for (const row of repo.rows) {
      if (focusedId !== null && row.workspace.id === focusedId) focused = { repo, row }
      else if (isFolded(row, focusedId)) stopped.push({ repo, row })
      else running.push({ kind: 'row', repo, row })
    }
    if (repo.shared !== null && repo.shared.status !== 'down' && focused?.repo !== repo) running.push({ kind: 'shared', repo })
  }
  return { focused, running, stopped }
}

/** One service line: the service, whether it is the repo's shared one, and whether it is known only by name. */
export interface ServiceLine {
  service: ServiceView
  shared: boolean
  /** A stopped stack lists no services: its names come from a sibling worktree, greyed. */
  placeholder: boolean
}

const asPlaceholder = (s: ServiceView): ServiceView => ({ ...s, status: 'Stopped', state: 'done', health: 'unknown', ports: [] })

/**
 * The services of a worktree: its isolated ones, then with `withShared` the repo's shared
 * instance's. A stopped stack lists none, so their names are borrowed, greyed, from another
 * worktree of the repo that lists some; the shared ones come from the shared instance when it
 * runs, whatever the worktree's own state.
 */
export function serviceLines(repo: RepoView, row: RowView, withShared: boolean): ServiceLine[] {
  const own = row.stack?.services ?? []
  const borrowing = own.length === 0 && row.stack?.status === 'down'
  const sibling = borrowing ? repo.rows.find((r) => r !== row && (r.stack?.services.length ?? 0) > 0)?.stack?.services ?? [] : []
  const source = borrowing ? sibling : own
  const line = (shared: boolean) => (s: ServiceView): ServiceLine =>
    borrowing ? { service: asPlaceholder(s), shared, placeholder: true } : { service: s, shared, placeholder: false }
  const isolated = source.filter((s) => s.tier === 'isolated').map(line(false))
  if (!withShared) return isolated
  const shared =
    repo.shared !== null && repo.shared.status !== 'down'
      ? repo.shared.services.map((s): ServiceLine => ({ service: s, shared: true, placeholder: false }))
      : source.filter((s) => s.tier === 'shared').map(line(true))
  return [...isolated, ...shared]
}

/**
 * Short, lowercase labels for a service's ports: the `_PORT` suffix and any words every one of
 * its port names starts with are dropped, keeping at least one word each. With siblings
 * `SUPABASE_SHARED_API_PORT`, `SUPABASE_SHARED_DB_SHADOW_PORT` gives `db shadow`.
 */
export function portLabels(ports: PortView[]): { name: string; label: string; port: number }[] {
  const words = ports.map((p) => {
    const w = p.name.split('_').filter((x) => x !== '')
    return w.length > 1 && w[w.length - 1].toUpperCase() === 'PORT' ? w.slice(0, -1) : w
  })
  let common = 0
  if (words.length > 1) {
    const shortest = Math.min(...words.map((w) => w.length))
    while (common < shortest - 1 && words.every((w) => w[common] === words[0][common])) common++
  }
  return ports.map((p, i) => ({
    name: p.name,
    label: (words[i].slice(common).join(' ') || p.name).toLowerCase(),
    port: p.port
  }))
}

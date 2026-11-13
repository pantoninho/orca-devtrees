// What the panel shows, as pure functions of the view: status dots, the order of rows, and short
// port labels. Kept apart from src/panel.tsx so tests read them without drawing.
import type { InstanceView, PortView, RowView, ServiceView } from './protocol'

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

/** A repo's rows split into those shown, focused first, and those folded away. */
export function splitRows(rows: RowView[], focusedId: string | null): { shown: RowView[]; folded: RowView[] } {
  const shown = rows.filter((r) => !isFolded(r, focusedId))
  const focused = shown.filter((r) => r.workspace.id === focusedId)
  return {
    shown: [...focused, ...shown.filter((r) => r.workspace.id !== focusedId)],
    folded: rows.filter((r) => isFolded(r, focusedId))
  }
}

/** Services that are running, for "Shared · 1 running". */
export const runningCount = (instance: InstanceView) => instance.services.filter((s) => s.state === 'active').length

/** The branch, when it says something the name does not. */
export function branchNote(row: RowView): string | null {
  const { branch, name } = row.workspace
  return branch !== null && branch !== name ? branch : null
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

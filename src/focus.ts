// Which worktree is focused. Orca's context gives only a display name, a branch and the ids of
// the focused workspace's terminals, with no path. Two workspaces in different repos can share
// a name and a branch (both "main" on main), so a name match alone is not enough to act on.
//
// The order:
// 1. The terminal ids, matched against `orca terminal list --json`, each of whose rows has the
//    exact worktree path. Unique only when every matched terminal is in the same worktree.
// 2. Without a terminal match: name and branch against `workspace.list`, used only when exactly
//    one workspace matches.
// 3. Otherwise nothing is chosen until the person picks one of the candidates.
// Pure functions, so tests run them without Orca.
import type { WorkspaceRef } from './protocol'

export interface Context {
  branch: string
  displayName: string
  terminals: { id: string; title?: string }[]
}

/** One `workspace.list` row. */
export interface Listed {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  path: string
  branch: string | null
  hostId: string | null
  /** The repository's display name; null for folders. Orca 1.4.256 and newer only. */
  project?: string | null
}

/** One `orca terminal list --json` row, reduced to what resolution needs. */
export interface TerminalRow {
  handle: string
  worktreePath: string
  worktreeId: string | null
  hostId: string | null
}

/** A worktree the person picked among candidates, valid only for the context it was made in. */
export interface Pick {
  displayName: string
  branch: string
  terminalIds: string[]
  workspaceId: string
}

export type Resolution =
  /** Nothing is focused, or the focused workspace is not local. */
  | { kind: 'none' }
  | { kind: 'unique'; by: 'terminals' | 'name' | 'pick'; workspace: WorkspaceRef; candidates: WorkspaceRef[] }
  | { kind: 'unresolved'; reason: 'ambiguous' | 'no-match'; candidates: WorkspaceRef[] }

export const branchName = (branch: string | null) => (branch ?? '').replace(/^refs\/heads\//, '')
const isLocalHost = (hostId: string | null) => hostId === null || hostId === 'local'
const refOf = (w: Listed): WorkspaceRef => ({
  id: w.id,
  name: w.name,
  path: w.path,
  branch: w.branch === null ? null : branchName(w.branch),
  project: typeof w.project === 'string' && w.project !== '' ? w.project : null
})
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i])
const terminalIds = (context: Context) => context.terminals.map((t) => t.id).sort()

/**
 * Reads `orca terminal list --json`. Null when the output is not that shape, so the caller
 * falls back to the name match.
 */
export function parseTerminals(stdout: string): TerminalRow[] | null {
  let doc: unknown
  try {
    doc = JSON.parse(stdout)
  } catch {
    return null
  }
  const rows = (doc as { result?: { terminals?: unknown } } | null)?.result?.terminals
  if (!Array.isArray(rows)) return null
  const out: TerminalRow[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    if (typeof r.handle !== 'string' || typeof r.worktreePath !== 'string' || r.worktreePath === '') continue
    out.push({
      handle: r.handle,
      worktreePath: r.worktreePath,
      worktreeId: typeof r.worktreeId === 'string' ? r.worktreeId : null,
      hostId: typeof r.executionHostId === 'string' ? r.executionHostId : null
    })
  }
  return out
}

/** Whether a pick still applies to this context. */
export function pickApplies(pick: Pick | null, context: Context | null): pick is Pick {
  return (
    pick !== null &&
    context !== null &&
    pick.displayName === context.displayName &&
    branchName(pick.branch) === branchName(context.branch) &&
    sameIds(pick.terminalIds, terminalIds(context))
  )
}

/**
 * Whether a pick survives a `workspace.changed` to `next`. A context with terminals names its
 * workspace for certain (terminal ids are unique), so the pick is kept while they stay the
 * same. A context without terminals looks the same for every workspace with that name and
 * branch, so it cannot tell a terminal change from a move to a twin: the pick is dropped.
 */
export function pickSurvives(pick: Pick | null, next: Context | null): boolean {
  return pickApplies(pick, next) && next !== null && next.terminals.length > 0
}

export function pickOf(context: Context, workspaceId: string): Pick {
  return {
    displayName: context.displayName,
    branch: context.branch,
    terminalIds: terminalIds(context),
    workspaceId
  }
}

/**
 * Resolves the focused worktree. `terminals` is null when `orca terminal list` could not be run
 * or read.
 */
export function resolve(
  context: Context | null,
  terminals: TerminalRow[] | null,
  workspaces: Listed[],
  pick: Pick | null
): Resolution {
  if (context === null) return { kind: 'none' }
  const local = workspaces.filter((w) => isLocalHost(w.hostId))
  const chosen = (candidates: WorkspaceRef[], reason: 'ambiguous' | 'no-match'): Resolution => {
    const picked = pickApplies(pick, context) ? candidates.find((c) => c.id === pick.workspaceId) : undefined
    if (picked) return { kind: 'unique', by: 'pick', workspace: picked, candidates }
    return { kind: 'unresolved', reason, candidates }
  }

  const ids = new Set(context.terminals.map((t) => t.id))
  const matched = (terminals ?? []).filter((row) => ids.has(row.handle))
  if (matched.length > 0) {
    const byPath = new Map<string, TerminalRow>()
    for (const row of matched) if (!byPath.has(row.worktreePath)) byPath.set(row.worktreePath, row)
    const refs = [...byPath.values()]
      .filter((row) => isLocalHost(row.hostId))
      .map((row): WorkspaceRef => {
        const listed = local.find((w) => w.path === row.worktreePath)
        if (listed) return refOf(listed)
        return {
          id: row.worktreeId ?? row.worktreePath,
          name: context.displayName,
          path: row.worktreePath,
          branch: branchName(context.branch) || null,
          project: null
        }
      })
    if (byPath.size === 1) {
      // The focused workspace is on another host: not supported.
      if (refs.length === 0) return { kind: 'none' }
      return { kind: 'unique', by: 'terminals', workspace: refs[0], candidates: [] }
    }
    if (refs.length === 0) return { kind: 'none' }
    return chosen(refs, 'ambiguous')
  }

  const named = local.filter(
    (w) => w.name === context.displayName && branchName(w.branch) === branchName(context.branch)
  )
  if (named.length === 1) return { kind: 'unique', by: 'name', workspace: refOf(named[0]), candidates: [] }
  if (named.length > 1) return chosen(named.map(refOf), 'ambiguous')
  return chosen(local.map(refOf), 'no-match')
}

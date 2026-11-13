// Which worktree is focused, used only to highlight its row: actions always run in the path of
// the row the person pressed. Orca's context gives only a display name, a branch and the ids of
// the focused workspace's terminals, with no path. Two workspaces in different repos can share
// a name and a branch (both "main" on main), so a name match alone does not name one.
//
// The order:
// 1. The terminal ids, matched against `orca terminal list --json`, each of whose rows has the
//    exact worktree path. Unique only when every matched terminal is in the same worktree.
// 2. Without a terminal match: name and branch against `workspace.list`, used only when exactly
//    one workspace matches.
// 3. Otherwise nothing is highlighted.
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

export type Resolution =
  /** Nothing is focused, or the focused workspace is not local. */
  | { kind: 'none' }
  | { kind: 'unique'; by: 'terminals' | 'name'; workspace: WorkspaceRef }
  | { kind: 'unresolved'; reason: 'ambiguous' | 'no-match' }

export const branchName = (branch: string | null) => (branch ?? '').replace(/^refs\/heads\//, '')
const isLocalHost = (hostId: string | null) => hostId === null || hostId === 'local'
export const refOf = (w: Listed): WorkspaceRef => ({
  id: w.id,
  name: w.name,
  path: w.path,
  branch: w.branch === null ? null : branchName(w.branch),
  project: typeof w.project === 'string' && w.project !== '' ? w.project : null
})

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

/**
 * Resolves the focused worktree. `terminals` is null when `orca terminal list` could not be run
 * or read.
 */
export function resolve(
  context: Context | null,
  terminals: TerminalRow[] | null,
  workspaces: Listed[]
): Resolution {
  if (context === null) return { kind: 'none' }
  const local = workspaces.filter((w) => isLocalHost(w.hostId))

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
      return { kind: 'unique', by: 'terminals', workspace: refs[0] }
    }
    if (refs.length === 0) return { kind: 'none' }
    return { kind: 'unresolved', reason: 'ambiguous' }
  }

  const named = local.filter(
    (w) => w.name === context.displayName && branchName(w.branch) === branchName(context.branch)
  )
  if (named.length === 1) return { kind: 'unique', by: 'name', workspace: refOf(named[0]) }
  return { kind: 'unresolved', reason: named.length > 1 ? 'ambiguous' : 'no-match' }
}

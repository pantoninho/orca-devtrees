// The plugin's worker: runs the devtrees CLI for the focused worktree, answers the panel, keeps
// the status bar item current, and prunes the stacks of removed worktrees.
// Orca starts it when the plugin is enabled (it has a status bar item) and restarts it on every
// save, so nothing here needs to survive a restart: the stack itself runs detached.
import type { OrcaWorkerApi } from 'orca/worker'
import {
  args,
  failureOf,
  readLs,
  statusBarOf,
  worktreeIdOf,
  type Runner,
  type StatusBarState
} from './devtrees'
import { nodeRunner } from './node-runner'
import type { InstanceView, StackAction, StackView, WorkspaceRef } from './protocol'

let runner: Runner = nodeRunner

/** Tests replace the devtrees CLI and the file system with a stub. */
export function setRunner(next: Runner): void {
  runner = next
}

const STATUS_ITEM = 'stack'
const DEFAULT_EXECUTABLE = 'devtrees'
const DEFAULT_POLL_SECONDS = 15
/** After a worktree is removed, how often and how long to retry a prune that left it behind. */
const PRUNE_RETRY_MS = 5000
const PRUNE_ATTEMPTS = 3

type Context = { branch: string; displayName: string } | null
type Listed = {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  path: string
  branch: string | null
  hostId: string | null
}
type Focus = { workspace: WorkspaceRef | null; candidates: WorkspaceRef[] }

const branchName = (branch: string | null) => (branch ?? '').replace(/^refs\/heads\//, '')
const isLocal = (w: Listed) => w.hostId === null || w.hostId === 'local'
const refOf = (w: Listed): WorkspaceRef => ({ id: w.id, name: w.name, path: w.path })
const repoOf = (workspaceId: string) => {
  const at = workspaceId.indexOf('::')
  return at > 0 ? workspaceId.slice(0, at) : null
}

export default function activate(orca: OrcaWorkerApi): void {
  /** What `workspace.changed` last said; undefined until it first fires. */
  let context: Context | undefined
  let focus: Focus | null = null
  /** A workspace the person picked among ambiguous candidates. */
  let picked: string | null = null
  const busy = new Map<string, NonNullable<StackView['busy']>>()
  const lastError = new Map<string, NonNullable<StackView['lastError']>>()
  let lastPosted = ''
  let lastStatus = ''
  let timer: ReturnType<typeof setInterval> | null = null
  let stopped = false

  async function setting<T>(key: string, fallback: T): Promise<T> {
    try {
      const value = await orca.settings.get(key)
      return (value === undefined || value === null || value === '' ? fallback : value) as T
    } catch {
      return fallback
    }
  }
  const executable = () => setting<string>('devtreesPath', DEFAULT_EXECUTABLE)

  async function listWorkspaces(): Promise<Listed[]> {
    const { workspaces } = await orca.host.call('workspace.list')
    return workspaces as Listed[]
  }

  /** Orca's context names the focused workspace by branch and display name; find its path. */
  async function resolveFocus(): Promise<Focus> {
    if (context === undefined) {
      context = (await orca.host.call('workspace.readContext')) as Context
    }
    if (context === null) return { workspace: null, candidates: [] }
    const { branch, displayName } = context
    const local = (await listWorkspaces()).filter(isLocal)
    let matches = local.filter((w) => w.name === displayName && branchName(w.branch) === branchName(branch))
    if (matches.length === 0) matches = local.filter((w) => w.name === displayName)
    if (matches.length === 0) matches = local.filter((w) => branchName(w.branch) === branchName(branch))
    if (matches.length > 1) {
      const configured: Listed[] = []
      for (const w of matches) if (await runner.exists(`${w.path}/devtrees.yaml`)) configured.push(w)
      if (configured.length > 0) matches = configured
    }
    const candidates = matches.length > 1 ? matches.map(refOf) : []
    const chosen = matches.find((w) => w.id === picked) ?? matches[0]
    return { workspace: chosen ? refOf(chosen) : null, candidates }
  }

  function base(workspace: WorkspaceRef | null, candidates: WorkspaceRef[], exe: string): StackView {
    return {
      kind: 'ok',
      workspace,
      candidates,
      message: null,
      stack: null,
      shared: null,
      busy: workspace ? (busy.get(workspace.path) ?? null) : null,
      lastError: workspace ? (lastError.get(workspace.path) ?? null) : null,
      executable: exe
    }
  }

  async function read(): Promise<StackView> {
    focus ??= await resolveFocus()
    const exe = await executable()
    const view = base(focus.workspace, focus.candidates, exe)
    const workspace = focus.workspace
    if (workspace === null) return { ...view, kind: 'no-workspace' }
    if (!(await runner.exists(`${workspace.path}/devtrees.yaml`))) return { ...view, kind: 'no-config' }
    const result = await runner.run(exe, args.ls, { cwd: workspace.path })
    if (result.code !== 0) {
      const failure = failureOf(result)
      if (failure.kind !== 'error') return { ...view, kind: failure.kind }
      return { ...view, kind: 'error', message: `${failure.code}: ${failure.message}` }
    }
    const worktreeId = worktreeIdOf(await runner.realpath(workspace.path), runner.sha256)
    const ls = readLs(result.stdout, worktreeId)
    if (ls === null) return { ...view, kind: 'error', message: 'devtrees printed output this plugin cannot read' }
    return { ...view, stack: ls.stack, shared: ls.shared }
  }

  async function showStatus(view: StackView): Promise<void> {
    const status: StatusBarState = statusBarOf(view)
    const key = JSON.stringify(status)
    if (key === lastStatus) return
    lastStatus = key
    try {
      await orca.host.call('statusBar.update', { id: STATUS_ITEM, ...status })
    } catch (error) {
      // Not every client draws a status bar (it is desktop only).
      lastStatus = ''
      orca.log(`status bar: ${(error as Error).message}`)
    }
  }

  /** Reads the stack and tells every open panel and the status bar when it changed. */
  async function refresh(): Promise<StackView> {
    let view: StackView
    try {
      view = await read()
    } catch (error) {
      view = { ...base(focus?.workspace ?? null, [], await executable()), kind: 'error', message: (error as Error).message }
    }
    if (stopped) return view
    const key = JSON.stringify(view)
    if (key !== lastPosted) {
      lastPosted = key
      orca.panels.post('stack.changed', view)
    }
    await showStatus(view)
    return view
  }

  async function run(path: string, action: StackAction, list: string[]) {
    const result = await runner.run(await executable(), list, { cwd: path, detached: true })
    if (result.code === 0) return true
    const failure = failureOf(result)
    const code = failure.kind === 'error' ? failure.code : failure.kind === 'too-old' ? 'TOO_OLD' : 'NOT_INSTALLED'
    const message =
      failure.kind === 'error'
        ? failure.message
        : failure.kind === 'too-old'
          ? 'This devtrees is too old for the plugin. Upgrade it.'
          : 'The devtrees executable was not found.'
    lastError.set(path, { action, code, message, at: Date.now() })
    return false
  }

  async function act(path: string, action: StackAction, service: string | null, stack: InstanceView | null) {
    lastError.delete(path)
    busy.set(path, { action, service, since: Date.now() })
    void refresh()
    try {
      if (action === 'up') await run(path, action, args.up())
      else if (action === 'down') await run(path, action, args.down)
      else if (action === 'restart-service' && service !== null) await run(path, action, args.restart(service))
      else if (action === 'restart') {
        // devtrees has no whole-stack restart: down, then up with the namespaces it had booted.
        const namespaces = stack?.status === 'down' ? [] : (stack?.namespaces ?? [])
        if (await run(path, action, args.down)) await run(path, action, args.up(namespaces))
      }
    } finally {
      busy.delete(path)
      await refresh()
    }
  }

  orca.panels.handle('stack.get', async (input) => {
    if (input?.refresh) focus = null
    return refresh()
  })

  orca.panels.handle('stack.action', async ({ action, service }) => {
    const view = await read()
    const path = view.workspace?.path
    if (view.kind !== 'ok' || path === undefined) return { started: false, reason: 'No devtrees stack here.' }
    if (busy.has(path)) return { started: false, reason: 'Another action is still running.' }
    if (action === 'restart-service') {
      const known = view.stack?.services.find((s) => s.name === service)
      if (!known) return { started: false, reason: `No isolated service named ${service ?? ''}.` }
    }
    // Answer now: `up` can take minutes, longer than a panel request may wait.
    void act(path, action, service ?? null, view.stack)
    return { started: true, reason: null }
  })

  orca.panels.handle('workspace.pick', async ({ workspaceId }) => {
    picked = workspaceId
    focus = null
    return refresh()
  })

  orca.events.on('workspace.changed', async (payload) => {
    context = payload.context
    picked = null
    focus = null
    await refresh()
  })

  orca.events.on('workspace.removed', async ({ workspaceId, path, kind }) => {
    if (kind !== 'worktree') return
    await prune(workspaceId, path)
    focus = null
    await refresh()
  })

  /**
   * Runs `devtrees prune` from a worktree of the same repo, so the removed worktree's instance
   * does not leak. Orca ids look like `<repo id>::<path>`; without that, every other worktree
   * with a devtrees.yaml gets a prune (it only removes instances of worktrees git no longer lists).
   */
  async function prune(removedId: string, removedPath: string): Promise<void> {
    const exe = await executable()
    const others = (await listWorkspaces()).filter(
      (w) => isLocal(w) && w.kind === 'worktree' && w.id !== removedId && w.path !== removedPath
    )
    const repo = repoOf(removedId)
    let targets = repo === null ? [] : others.filter((w) => repoOf(w.id) === repo).slice(0, 1)
    if (targets.length === 0) {
      const seen = new Set<string>()
      for (const w of others) {
        const key = repoOf(w.id) ?? w.path
        if (seen.has(key) || !(await runner.exists(`${w.path}/devtrees.yaml`))) continue
        seen.add(key)
        targets.push(w)
      }
    }
    const removed = worktreeIdOf(removedPath, runner.sha256)
    for (const target of targets) {
      for (let attempt = 1; attempt <= PRUNE_ATTEMPTS && !stopped; attempt++) {
        const result = await runner.run(exe, args.prune, { cwd: target.path, detached: true })
        if (result.code !== 0) {
          const failure = failureOf(result)
          orca.log(`prune in ${target.path} failed: ${failure.kind === 'error' ? failure.message : failure.kind}`)
          break
        }
        orca.log(`prune in ${target.path}: ${result.stdout.trim()}`)
        // Git may still list the worktree for a moment after Orca reports it removed.
        if (!(await stillListed(exe, target.path, removed))) break
        if (attempt < PRUNE_ATTEMPTS) await new Promise((done) => setTimeout(done, PRUNE_RETRY_MS))
      }
    }
  }

  async function stillListed(exe: string, cwd: string, worktreeId: string): Promise<boolean> {
    const result = await runner.run(exe, args.ls, { cwd })
    if (result.code !== 0) return false
    const ls = readLs(result.stdout, worktreeId)
    return ls !== null && ls.stack.status !== 'down'
  }

  /** Polls for changes made outside the panel: agents and terminals running devtrees, crashes. */
  async function schedule(): Promise<void> {
    if (timer !== null) clearInterval(timer)
    timer = null
    const seconds = Number(await setting<number>('pollSeconds', DEFAULT_POLL_SECONDS))
    if (stopped || !(seconds > 0)) return
    timer = setInterval(() => {
      if (focus?.workspace && !busy.has(focus.workspace.path)) void refresh()
    }, seconds * 1000)
    ;(timer as { unref?: () => void }).unref?.()
  }

  orca.settings.onDidChange(() => {
    void schedule()
    void refresh()
  })
  void schedule()

  deactivateHook = () => {
    stopped = true
    if (timer !== null) clearInterval(timer)
  }
}

let deactivateHook: (() => void) | null = null

export function deactivate(): void {
  deactivateHook?.()
  deactivateHook = null
}

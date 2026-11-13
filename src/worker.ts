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
import {
  parseTerminals,
  pickOf,
  pickSurvives,
  resolve,
  type Context,
  type Listed,
  type Pick,
  type Resolution,
  type TerminalRow
} from './focus'
import { nodeRunner } from './node-runner'
import type { InstanceView, StackAction, StackView, WorkspaceRef } from './protocol'

let runner: Runner = nodeRunner

/** Tests replace the devtrees, orca and git CLIs and the file system with a stub. */
export function setRunner(next: Runner): void {
  runner = next
}

const STATUS_ITEM = 'stack'
const DEFAULT_EXECUTABLE = 'devtrees'
const DEFAULT_ORCA = 'orca'
const DEFAULT_POLL_SECONDS = 15
/** After a worktree is removed, how often and how long to retry a prune that left it behind. */
const PRUNE_RETRY_MS = 5000
const PRUNE_ATTEMPTS = 3
/** `orca terminal list` and `git rev-parse` answer in well under a second. */
const LOOKUP_TIMEOUT_MS = 10000
const TERMINAL_LIST = ['terminal', 'list', '--json']
const COMMON_DIR = ['rev-parse', '--path-format=absolute', '--git-common-dir']

const isLocal = (w: Listed) => w.hostId === null || w.hostId === 'local'
const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path)
const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''

const UNRESOLVED_TEXT = {
  ambiguous: 'More than one worktree matches the focused one. Pick the one you are in. Nothing runs until you do.',
  'no-match': 'No worktree matches the focused one. Pick it below. Nothing runs until you do.'
} as const

export default function activate(orca: OrcaWorkerApi): void {
  /** What `workspace.changed` last said; undefined until it first fires. */
  let context: Context | null | undefined
  /** Bumped on every `workspace.changed`: a resolution made for an older one is discarded. */
  let generation = 0
  let focus: { generation: number; resolution: Resolution } | null = null
  /** A worktree the person picked among candidates; see `pickSurvives`. */
  let pick: Pick | null = null
  /** Each local worktree's git common dir, by path: which repo it belongs to, for prune. */
  const commonDirs = new Map<string, string>()
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
  const orcaExecutable = () => setting<string>('orcaPath', DEFAULT_ORCA)

  async function listWorkspaces(): Promise<Listed[]> {
    const { workspaces } = await orca.host.call('workspace.list')
    return workspaces as Listed[]
  }

  /** The rows of `orca terminal list --json`, or null when it cannot be run or read. */
  async function listTerminals(): Promise<TerminalRow[] | null> {
    try {
      const result = await runner.run(await orcaExecutable(), TERMINAL_LIST, { cwd: '/', timeoutMs: LOOKUP_TIMEOUT_MS })
      if (result.code !== 0) {
        orca.log(`orca terminal list failed: ${firstLine(result.stderr || result.stdout) || 'no output'}`)
        return null
      }
      const rows = parseTerminals(result.stdout)
      if (rows === null) orca.log('orca terminal list printed output this plugin cannot read')
      return rows
    } catch (error) {
      orca.log(`orca terminal list failed: ${(error as Error).message}`)
      return null
    }
  }

  async function resolveNow(): Promise<Resolution> {
    if (context === undefined) {
      context = (await orca.host.call('workspace.readContext')) as Context | null
    }
    const current = context
    if (current === null) return { kind: 'none' }
    // Only look terminals up when the context has some to match.
    const terminals = current.terminals.length > 0 ? await listTerminals() : null
    return resolve(current, terminals, await listWorkspaces(), pick)
  }

  /** The focused worktree for the current context, resolved again after each workspace.changed. */
  async function currentFocus(): Promise<Resolution> {
    for (;;) {
      const at = generation
      if (focus !== null && focus.generation === at) return focus.resolution
      const resolution = await resolveNow()
      if (at === generation) {
        focus = { generation: at, resolution }
        return resolution
      }
    }
  }

  /** Records the git common dir of each local worktree not yet known. */
  async function indexRepos(listed?: Listed[]): Promise<void> {
    let workspaces: Listed[]
    try {
      workspaces = listed ?? (await listWorkspaces())
    } catch (error) {
      orca.log(`workspace.list failed: ${(error as Error).message}`)
      return
    }
    const fresh = workspaces.filter((w) => isLocal(w) && w.kind === 'worktree' && !commonDirs.has(trimSlash(w.path)))
    await Promise.all(
      fresh.map(async (w) => {
        const result = await runner.run('git', COMMON_DIR, { cwd: w.path, timeoutMs: LOOKUP_TIMEOUT_MS })
        const dir = result.code === 0 ? firstLine(result.stdout) : ''
        if (dir !== '') commonDirs.set(trimSlash(w.path), trimSlash(dir))
      })
    )
  }

  function base(
    workspace: WorkspaceRef | null,
    resolvedBy: StackView['resolvedBy'],
    candidates: WorkspaceRef[],
    exe: string
  ): StackView {
    return {
      kind: 'ok',
      workspace,
      resolvedBy: workspace ? resolvedBy : null,
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
    const resolution = await currentFocus()
    const exe = await executable()
    if (resolution.kind === 'none') return { ...base(null, null, [], exe), kind: 'no-workspace' }
    if (resolution.kind === 'unresolved') {
      return {
        ...base(null, null, resolution.candidates, exe),
        kind: 'unresolved',
        message: UNRESOLVED_TEXT[resolution.reason]
      }
    }
    const workspace = resolution.workspace
    const view = base(workspace, resolution.by, resolution.candidates, exe)
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
    for (let attempt = 0; ; attempt++) {
      const at = generation
      try {
        view = await read()
      } catch (error) {
        view = { ...base(null, null, [], await executable()), kind: 'error', message: (error as Error).message }
      }
      // Focus moved while reading: what was read is for the old worktree.
      if (at === generation || attempt >= 3) break
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
    // Resolve again: an action never runs on a resolution made before the last focus change.
    focus = null
    const at = generation
    const view = await read()
    if (view.kind === 'unresolved') {
      return { started: false, reason: 'Pick the worktree first: Orca does not say which one is focused.' }
    }
    const path = view.workspace?.path
    if (view.kind !== 'ok' || path === undefined) return { started: false, reason: 'No devtrees stack here.' }
    if (at !== generation) return { started: false, reason: 'The focused worktree changed. Press again.' }
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
    const resolution = await currentFocus()
    // Only a worktree on offer can be picked, and only while the context does not name one.
    const offered = resolution.kind === 'unresolved' || (resolution.kind === 'unique' && resolution.by === 'pick')
    if (offered && context && resolution.candidates.some((c) => c.id === workspaceId)) {
      pick = pickOf(context, workspaceId)
      focus = null
    }
    return refresh()
  })

  // Fires on every focus change, also between workspaces whose payloads look the same, and when
  // the focused workspace's terminals change. Always resolve again.
  orca.events.on('workspace.changed', async (payload) => {
    const next = payload.context as Context | null
    if (!pickSurvives(pick, next)) pick = null
    context = next
    generation++
    focus = null
    void indexRepos()
    await refresh()
  })

  orca.events.on('workspace.removed', async ({ path, kind }) => {
    if (kind !== 'worktree') return
    await prune(trimSlash(path))
    focus = null
    await refresh()
  })

  /**
   * Runs `devtrees prune` from one surviving worktree of the removed worktree's repo, so its
   * instance does not leak. The repo is the git common dir recorded while the worktree still
   * existed. A worktree the worker never saw is skipped: pruning other repos is not this
   * plugin's to decide.
   */
  async function prune(removedPath: string): Promise<void> {
    const repo = commonDirs.get(removedPath)
    if (repo === undefined) {
      orca.log(`prune skipped: ${removedPath} was not seen while it existed, so its repo is unknown`)
      return
    }
    let listed: Listed[]
    try {
      listed = await listWorkspaces()
    } catch (error) {
      orca.log(`prune skipped: workspace.list failed: ${(error as Error).message}`)
      return
    }
    await indexRepos(listed)
    const sameRepo = listed.filter(
      (w) => isLocal(w) && w.kind === 'worktree' && trimSlash(w.path) !== removedPath && commonDirs.get(trimSlash(w.path)) === repo
    )
    let target: Listed | undefined
    for (const w of sameRepo) {
      if (await runner.exists(`${w.path}/devtrees.yaml`)) {
        target = w
        break
      }
    }
    target ??= sameRepo[0]
    commonDirs.delete(removedPath)
    if (target === undefined) {
      orca.log(`prune skipped: no other worktree of ${repo} is open in Orca`)
      return
    }
    const exe = await executable()
    const removed = worktreeIdOf(removedPath, runner.sha256)
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
      void indexRepos()
      const resolution = focus?.resolution
      if (resolution?.kind === 'unique' && !busy.has(resolution.workspace.path)) void refresh()
    }, seconds * 1000)
    ;(timer as { unref?: () => void }).unref?.()
  }

  orca.settings.onDidChange(() => {
    // `orcaPath` may have changed: resolve again.
    focus = null
    void schedule()
    void refresh()
  })
  void schedule()
  void indexRepos()

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

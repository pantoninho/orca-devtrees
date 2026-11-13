// The plugin's worker: lists every local worktree with a devtrees.yaml and its stack, runs the
// panel's actions in the path of the row pressed, keeps the status bar item current for the
// focused row, and prunes the stacks of removed worktrees.
// Orca starts it when the plugin is enabled (it has a status bar item) and restarts it on every
// save, so nothing here needs to survive a restart: the stacks themselves run detached.
import type { OrcaWorkerApi } from 'orca/worker'
import {
  args,
  failureOf,
  readLs,
  repoLabel,
  stackOf,
  statusBarOf,
  terminalCommand,
  worktreeIdOf,
  type LsRead,
  type Runner,
  type StatusBarState
} from './devtrees'
import { parseTerminals, refOf, resolve, type Context, type Listed, type Resolution, type TerminalRow } from './focus'
import { nodeRunner } from './node-runner'
import type { InstanceView, RepoView, RowView, StackAction, StackView, WorkspaceRef } from './protocol'

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

/** What one `devtrees ls` in a repo gave. */
type RepoRead =
  | { kind: 'ok'; ls: LsRead }
  | { kind: 'not-installed' }
  | { kind: 'too-old' }
  | { kind: 'error'; message: string }

/** A local workspace with a devtrees.yaml, as one refresh found it. */
interface Row {
  ref: WorkspaceRef
  /** Without a trailing slash: the key of `busy`, `lastError` and `commonDirs`. */
  key: string
  /** The git common dir, or `key` when git does not name one. */
  repo: string
  worktreeId: string
}

/**
 * Which repos a refresh reads again: all of them, those without a running action (the poll),
 * none (repost what is known), or one repo (after its action).
 */
type Reread = 'all' | 'idle' | 'none' | { repo: string }

export default function activate(orca: OrcaWorkerApi): void {
  /** What `workspace.changed` last said; undefined until it first fires. */
  let context: Context | null | undefined
  /** Bumped on every `workspace.changed`: a resolution made for an older one is discarded. */
  let generation = 0
  let focus: { generation: number; resolution: Resolution; terminalsFailed: boolean } | null = null
  /** Each local worktree's git common dir, by path: which repo it belongs to. */
  const commonDirs = new Map<string, string>()
  /** The newest `ls` of each repo, with the number of the refresh that started it. */
  const reads = new Map<string, { seq: number; read: RepoRead }>()
  /** The rows the newest finished scan found. */
  let rows: { seq: number; list: Row[] } = { seq: 0, list: [] }
  let seq = 0
  const busy = new Map<string, NonNullable<RowView['busy']>>()
  const lastError = new Map<string, NonNullable<RowView['lastError']>>()
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

  const repoOf = (key: string) => commonDirs.get(key) ?? key

  /**
   * Opens a visible, focused terminal tab with the orca CLI. False when the CLI cannot be run
   * or does not answer `ok: true`, so the caller falls back to the host call.
   */
  async function createVisibleTerminal(path: string, title: string, command: string): Promise<boolean> {
    try {
      const argv = ['terminal', 'create', '--worktree', `path:${path}`, '--title', title, '--command', command, '--focus', '--json']
      const result = await runner.run(await orcaExecutable(), argv, { cwd: '/', timeoutMs: LOOKUP_TIMEOUT_MS })
      if (result.code !== 0) {
        orca.log(`orca terminal create failed: ${firstLine(result.stderr || result.stdout) || 'no output'}`)
        return false
      }
      const doc = JSON.parse(result.stdout) as { ok?: unknown } | null
      if (doc?.ok === true) return true
      orca.log('orca terminal create did not answer ok')
      return false
    } catch (error) {
      orca.log(`orca terminal create failed: ${(error as Error).message}`)
      return false
    }
  }

  /** The rows of `orca terminal list --json`, or null when it cannot be run or read. */
  async function listTerminals(): Promise<TerminalRow[] | null> {
    try {
      const result = await runner.run(await orcaExecutable(), TERMINAL_LIST, { cwd: '/', timeoutMs: LOOKUP_TIMEOUT_MS })
      if (result.code !== 0) {
        orca.log(`orca terminal list failed: ${firstLine(result.stderr || result.stdout) || 'no output'}`)
        return null
      }
      const parsed = parseTerminals(result.stdout)
      if (parsed === null) orca.log('orca terminal list printed output this plugin cannot read')
      return parsed
    } catch (error) {
      orca.log(`orca terminal list failed: ${(error as Error).message}`)
      return null
    }
  }

  /**
   * The focused worktree, resolved again after each workspace.changed. Only highlights a row:
   * nothing else reads it.
   */
  async function currentFocus(listed: Listed[]): Promise<NonNullable<typeof focus>> {
    for (;;) {
      const at = generation
      if (focus !== null && focus.generation === at) return focus
      if (context === undefined) {
        try {
          context = (await orca.host.call('workspace.readContext')) as Context | null
        } catch (error) {
          orca.log(`workspace.readContext failed: ${(error as Error).message}`)
          context = null
        }
      }
      const current = context
      // Only look terminals up when the context has some to match.
      const terminals = current !== null && current.terminals.length > 0 ? await listTerminals() : []
      const next = {
        generation: at,
        resolution: resolve(current, terminals, listed),
        terminalsFailed: terminals === null
      }
      if (at === generation) {
        focus = next
        return next
      }
    }
  }

  /** Records the git common dir of each local workspace not yet known. */
  async function indexRepos(listed: Listed[]): Promise<void> {
    const fresh = listed.filter((w) => isLocal(w) && !commonDirs.has(trimSlash(w.path)))
    await Promise.all(
      fresh.map(async (w) => {
        const result = await runner.run('git', COMMON_DIR, { cwd: w.path, timeoutMs: LOOKUP_TIMEOUT_MS })
        const dir = result.code === 0 ? firstLine(result.stdout) : ''
        if (dir !== '') commonDirs.set(trimSlash(w.path), trimSlash(dir))
      })
    )
  }

  /** Every local workspace with a devtrees.yaml, in `workspace.list` order. */
  async function scan(listed: Listed[]): Promise<Row[]> {
    const local = listed.filter(isLocal)
    await indexRepos(local)
    const found = await Promise.all(
      local.map(async (w): Promise<Row | null> => {
        if (!(await runner.exists(`${w.path}/devtrees.yaml`))) return null
        const key = trimSlash(w.path)
        return {
          ref: refOf(w),
          key,
          repo: repoOf(key),
          worktreeId: worktreeIdOf(await runner.realpath(w.path), runner.sha256)
        }
      })
    )
    return found.filter((r): r is Row => r !== null)
  }

  /** Runs `devtrees ls` in one worktree: it lists every instance of that worktree's repo. */
  async function readRepo(exe: string, cwd: string): Promise<RepoRead> {
    const result = await runner.run(exe, args.ls, { cwd })
    if (result.code !== 0) {
      const failure = failureOf(result)
      if (failure.kind !== 'error') return { kind: failure.kind }
      return { kind: 'error', message: `${failure.code}: ${failure.message}` }
    }
    const ls = readLs(result.stdout)
    return ls === null ? { kind: 'error', message: 'devtrees printed output this plugin cannot read' } : { kind: 'ok', ls }
  }

  const repoBusy = (repo: string) => [...busy.keys()].some((key) => repoOf(key) === repo)

  function rereads(reread: Reread, repo: string): boolean {
    if (!reads.has(repo) || reread === 'all') return true
    if (reread === 'none') return false
    if (reread === 'idle') return !repoBusy(repo)
    return reread.repo === repo
  }

  function build(list: Row[], found: NonNullable<typeof focus>, exe: string): StackView {
    const groups = new Map<string, Row[]>()
    for (const row of list) groups.set(row.repo, [...(groups.get(row.repo) ?? []), row])
    let kind: StackView['kind'] = 'ok'
    const repos: RepoView[] = []
    for (const [repo, members] of groups) {
      const read = reads.get(repo)?.read ?? { kind: 'error', message: 'Not read yet.' }
      if (read.kind === 'not-installed') kind = 'not-installed'
      else if (read.kind === 'too-old' && kind === 'ok') kind = 'too-old'
      repos.push({
        key: repo,
        label: repoLabel(repo, members.map((m) => m.ref.project).find((p) => p !== null) ?? null),
        kind: read.kind === 'error' ? 'error' : 'ok',
        message: read.kind === 'error' ? read.message : null,
        shared: read.kind === 'ok' ? read.ls.shared : null,
        rows: members.map((m) => ({
          workspace: m.ref,
          stack: read.kind === 'ok' ? stackOf(read.ls, m.worktreeId) : null,
          busy: busy.get(m.key) ?? null,
          lastError: lastError.get(m.key) ?? null
        }))
      })
    }
    repos.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key))
    const resolution = found.resolution
    const focusedPath = resolution.kind === 'unique' ? trimSlash(resolution.workspace.path) : null
    const focusedId = list.find((r) => r.key === focusedPath)?.ref.id ?? null
    return {
      kind,
      repos,
      focusedId,
      focusUnknown: resolution.kind !== 'unique' && found.terminalsFailed,
      executable: exe
    }
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

  /** Lists the rows, reads their repos, and tells every open panel and the status bar. */
  async function refresh(reread: Reread): Promise<StackView> {
    const at = ++seq
    const exe = await executable()
    let listed: Listed[] | null = null
    try {
      listed = await listWorkspaces()
    } catch (error) {
      orca.log(`workspace.list failed: ${(error as Error).message}`)
    }
    if (listed !== null) {
      const list = await scan(listed)
      if (at > rows.seq) rows = { seq: at, list }
    }
    const list = rows.list
    const repos = [...new Map(list.map((r) => [r.repo, r])).values()]
    await Promise.all(
      repos
        .filter((r) => rereads(reread, r.repo))
        .map(async (r) => {
          const read = await readRepo(exe, r.ref.path)
          // A slower, older read never replaces a newer one.
          if ((reads.get(r.repo)?.seq ?? 0) < at) reads.set(r.repo, { seq: at, read })
        })
    )
    const found = await currentFocus(listed ?? [])
    const view = build(rows.list, found, exe)
    if (stopped) return view
    const key = JSON.stringify(view)
    if (key !== lastPosted) {
      lastPosted = key
      orca.panels.post('stack.changed', view)
    }
    await showStatus(view)
    return view
  }

  async function run(cwd: string, key: string, action: StackAction, list: string[]) {
    const result = await runner.run(await executable(), list, { cwd, detached: true })
    if (result.code === 0) return true
    const failure = failureOf(result)
    const code = failure.kind === 'error' ? failure.code : failure.kind === 'too-old' ? 'TOO_OLD' : 'NOT_INSTALLED'
    const message =
      failure.kind === 'error'
        ? failure.message
        : failure.kind === 'too-old'
          ? 'This devtrees is too old for the plugin. Upgrade it.'
          : 'The devtrees executable was not found.'
    lastError.set(key, { action, code, message, at: Date.now() })
    return false
  }

  async function act(cwd: string, action: StackAction, service: string | null, stack: InstanceView | null) {
    const key = trimSlash(cwd)
    lastError.delete(key)
    busy.set(key, { action, service, since: Date.now() })
    void refresh('none')
    try {
      if (action === 'up') await run(cwd, key, action, args.up())
      else if (action === 'down') await run(cwd, key, action, args.down)
      else if (action === 'restart-service' && service !== null) await run(cwd, key, action, args.restart(service))
      else if (action === 'restart') {
        // devtrees has no whole-stack restart: down, then up with the namespaces it had booted.
        const namespaces = stack?.status === 'down' ? [] : (stack?.namespaces ?? [])
        if (await run(cwd, key, action, args.down)) await run(cwd, key, action, args.up(namespaces))
      }
    } finally {
      busy.delete(key)
      await refresh({ repo: repoOf(key) })
    }
  }

  const refuse = (reason: string) => ({ started: false, reason })

  orca.panels.handle('stack.get', async (input) => {
    if (input?.refresh) focus = null
    return refresh('all')
  })

  /**
   * The pressed row's workspace, looked up again by its id in `workspace.list`: never the
   * focused one. A string is why it cannot be used.
   */
  async function target(workspaceId: string): Promise<Listed | string> {
    let listed: Listed[]
    try {
      listed = await listWorkspaces()
    } catch (error) {
      return `Could not list workspaces: ${(error as Error).message}`
    }
    const w = listed.find((x) => x.id === workspaceId)
    if (w === undefined) return 'That worktree is no longer open in Orca.'
    if (!isLocal(w)) return 'Only local worktrees are supported.'
    if (!(await runner.exists(`${w.path}/devtrees.yaml`))) return `${w.name} has no devtrees.yaml.`
    return w
  }

  orca.panels.handle('stack.action', async ({ workspaceId, action, service }) => {
    const w = await target(workspaceId)
    if (typeof w === 'string') return refuse(w)
    let stack: InstanceView | null = null
    if (action === 'restart' || action === 'restart-service') {
      // Read the stack now: restart needs its namespaces, and a service must be one it runs.
      const read = await readRepo(await executable(), w.path)
      if (read.kind === 'error') return refuse(read.message)
      if (read.kind !== 'ok') return refuse(read.kind === 'too-old' ? 'devtrees is too old. Upgrade it.' : 'devtrees was not found.')
      stack = stackOf(read.ls, worktreeIdOf(await runner.realpath(w.path), runner.sha256))
      if (action === 'restart-service' && !stack.services.some((s) => s.name === service && s.tier === 'isolated')) {
        return refuse(`No isolated service named ${service ?? ''}.`)
      }
    }
    if (busy.has(trimSlash(w.path))) return refuse('Another action is still running in this worktree.')
    // Answer now: `up` can take minutes, longer than a panel request may wait.
    void act(w.path, action, service ?? null, stack)
    return { started: true, reason: null }
  })

  // Opens a terminal in the pressed row's workspace: the TUI, or a log stream that follows.
  orca.panels.handle('terminal.open', async ({ workspaceId, what, service, shared }) => {
    const w = await target(workspaceId)
    if (typeof w === 'string') return refuse(w)
    if (service !== undefined && (what !== 'logs' || service === '')) return refuse('Only logs take a service.')
    const isShared = shared === true
    const where = isShared ? repoLabel(repoOf(trimSlash(w.path)), refOf(w).project) : w.name
    const { command, title } = terminalCommand(await executable(), what, { service: service ?? null, shared: isShared, where })
    try {
      if (!(await createVisibleTerminal(w.path, title, command))) {
        // `terminal.create` opens a background terminal with no tab, so it is only the fallback.
        orca.log('opened the terminal with the host terminal.create fallback; it may have no tab')
        await orca.host.call('terminal.create', { workspaceId: w.id, title, command })
      }
    } catch (error) {
      return refuse(`Could not open a terminal: ${(error as Error).message}`)
    }
    return { started: true, reason: null }
  })

  // Fires on every focus change, also between workspaces whose payloads look the same, and when
  // the focused workspace's terminals change. Resolve the highlight again.
  orca.events.on('workspace.changed', async (payload) => {
    context = payload.context as Context | null
    generation++
    focus = null
    await refresh('idle')
  })

  orca.events.on('workspace.removed', async ({ path, kind }) => {
    if (kind !== 'worktree') return
    await prune(trimSlash(path))
    focus = null
    await refresh('idle')
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
    busy.delete(removedPath)
    lastError.delete(removedPath)
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
    const read = await readRepo(exe, cwd)
    return read.kind === 'ok' && stackOf(read.ls, worktreeId).status !== 'down'
  }

  /** Polls for changes made outside the panel: agents and terminals running devtrees, crashes. */
  async function schedule(): Promise<void> {
    if (timer !== null) clearInterval(timer)
    timer = null
    const seconds = Number(await setting<number>('pollSeconds', DEFAULT_POLL_SECONDS))
    if (stopped || !(seconds > 0)) return
    // A repo with a running action is skipped: its action refreshes it when it ends.
    timer = setInterval(() => void refresh('idle'), seconds * 1000)
    ;(timer as { unref?: () => void }).unref?.()
  }

  orca.settings.onDidChange(() => {
    // `orcaPath` may have changed: resolve the highlight again.
    focus = null
    void schedule()
    void refresh('all')
  })
  void schedule()
  // Learn each worktree's repo early, so a removal right after start can still be pruned.
  void listWorkspaces().then(
    (listed) => indexRepos(listed),
    (error: Error) => orca.log(`workspace.list failed: ${error.message}`)
  )

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

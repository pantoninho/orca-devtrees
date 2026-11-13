// The worker over a mocked devtrees CLI: src/fake-runner.ts stands in for it, for the orca and
// git CLIs, and for the file system.
import { afterEach, assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import { FakeRunner, fail, idOf, ok, terminal, until } from './fake-runner'
import type { RowView, StackView } from './protocol'
import * as main from './worker'

// Two repos, each with a main checkout called "main" on `main`.
const MAIN_PATH = '/work/app'
const PATH = '/work/wt/feature-x'
const GONE = '/work/wt/gone'
const BARE = '/work/wt/no-config'
const OTHER = '/work/other'
const REMOTE = '/home/me/app'
const APP_GIT = '/work/app/.git'
const OTHER_GIT = '/work/other/.git'

// Orca's ids carry no repo or path.
const row = (n: number, name: string, path: string, branch: string, hostId = 'local') => ({
  id: `identity:wt2:local:0000000${n}`,
  kind: 'worktree' as const,
  name,
  path,
  branch: `refs/heads/${branch}`,
  hostId
})
const MAIN_ROW = row(1, 'main', MAIN_PATH, 'main')
const FEATURE_ROW = row(2, 'feature-x', PATH, 'feature-x')
const OTHER_ROW = row(3, 'main', OTHER, 'main')
const GONE_ROW = row(4, 'gone', GONE, 'gone')
const BARE_ROW = row(5, 'no-config', BARE, 'no-config')
const REMOTE_ROW = row(6, 'app', REMOTE, 'main', 'ssh-host')

const ctx = (displayName: string, branch: string, terminals: string[] = []) => ({
  displayName,
  branch,
  terminals: terminals.map((id) => ({ id, title: 'zsh' }))
})
/** feature-x is focused, found by its terminal. */
const focused = ctx('feature-x', 'feature-x', ['term_feature'])
/** "main" on main: either repo's main checkout. */
const twins = ctx('main', 'main')

let worker: TestWorker | undefined
afterEach(async () => {
  await worker?.deactivate()
  worker = undefined
})

type Start = {
  context?: unknown
  settings?: Record<string, string | number>
  workspaces?: { list: unknown[] }
}

/**
 * A runner where each worktree knows its repo, main, feature-x and other have a devtrees.yaml,
 * and the main checkouts' stacks run.
 */
function machine(): FakeRunner {
  const runner = new FakeRunner()
  runner.terminals = [terminal('term_feature', PATH), terminal('term_main', MAIN_PATH), terminal('term_other', OTHER)]
  for (const path of [MAIN_PATH, PATH, GONE, BARE]) runner.commonDirs.set(path, APP_GIT)
  runner.commonDirs.set(OTHER, OTHER_GIT)
  for (const path of [MAIN_PATH, PATH, OTHER]) runner.files.add(`${path}/devtrees.yaml`)
  runner.running = [MAIN_PATH, OTHER]
  return runner
}

async function start(runner: FakeRunner, options: Start = {}) {
  main.setRunner(runner)
  const workspaces = options.workspaces ?? { list: [MAIN_ROW, FEATURE_ROW, OTHER_ROW, BARE_ROW, REMOTE_ROW] }
  const host = mockHost({
    results: {
      'workspace.readContext': options.context === undefined ? focused : options.context,
      'workspace.list': () => ({ workspaces: workspaces.list, truncated: false }),
      'statusBar.update': { ok: true },
      'terminal.create': { terminalId: 'term_new' }
    },
    settings: options.settings ?? {}
  })
  worker = await mountWorker(main, { host })
  return worker
}

const statusUpdates = (w: TestWorker) =>
  w.host.callsOf('statusBar.update') as { text: string; visible: boolean }[]
const lastPost = (w: TestWorker) => w.posts.at(-1)?.payload as StackView
const lookups = (runner: FakeRunner, subcommand: string) => runner.calls.filter((c) => c.args[0] === subcommand)
const prunes = (runner: FakeRunner) => runner.calls.filter((c) => c.args[0] === 'prune')
const lsIn = (runner: FakeRunner, repo: string) =>
  lookups(runner, 'ls').filter((c) => runner.commonDirs.get(c.cwd) === repo).length
const actionCalls = (runner: FakeRunner) => runner.devtrees.filter((c) => c.args[0] !== 'ls')

function rowAt(view: StackView, path: string): RowView {
  for (const repo of view.repos) {
    const found = repo.rows.find((r) => r.workspace.path === path)
    if (found) return found
  }
  throw new Error(`no row for ${path}`)
}

// Rows.

test('lists every local worktree with a devtrees.yaml, grouped by repo', async () => {
  const runner = machine()
  const w = await start(runner)
  const view = await w.request('stack.get', {})

  assert.equal(view.kind, 'ok')
  // Two repos, each with a "main" on main, are two groups, labelled by their main checkout.
  assert.deepEqual(
    view.repos.map((r) => ({ key: r.key, label: r.label, rows: r.rows.map((x) => x.workspace.path) })),
    [
      { key: APP_GIT, label: 'app', rows: [MAIN_PATH, PATH] },
      { key: OTHER_GIT, label: 'other', rows: [OTHER] }
    ]
  )
  // No devtrees.yaml, or on another host: not listed.
  assert.ok(view.repos.every((r) => r.rows.every((x) => x.workspace.path !== BARE && x.workspace.path !== REMOTE)))
  assert.deepEqual(rowAt(view, MAIN_PATH).workspace, { id: MAIN_ROW.id, name: 'main', path: MAIN_PATH, branch: 'main', project: null })
  // Plain JSON: nothing undefined.
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view)
  assert.deepEqual(w.refusals, [])
})

test('one ls per repo, matched to the rows by worktree id', async () => {
  const runner = machine()
  const w = await start(runner)
  await w.request('stack.get', {})
  const app = lsIn(runner, APP_GIT)
  const other = lsIn(runner, OTHER_GIT)
  const view = await w.request('stack.get', {})

  // app has two rows and other one: one ls each per refresh.
  assert.equal(lsIn(runner, APP_GIT), app + 1)
  assert.equal(lsIn(runner, OTHER_GIT), other + 1)
  const mainRow = rowAt(view, MAIN_PATH)
  assert.equal(mainRow.stack?.id, idOf(MAIN_PATH))
  assert.equal(mainRow.stack?.status, 'up')
  assert.deepEqual(mainRow.stack?.services.map((s) => s.name), ['web', 'worker'])
  assert.deepEqual(mainRow.stack?.services[0].ports, [{ name: 'WEB_PORT', port: 38176 }])
  // feature-x is in the same repo but not running: down, from the same ls.
  assert.deepEqual(rowAt(view, PATH).stack, { status: 'down', id: idOf(PATH), namespaces: [], services: [] })
  // The other repo's main is its own instance, not app's.
  assert.equal(rowAt(view, OTHER).stack?.id, idOf(OTHER))
  assert.equal(view.repos[0].shared?.services[0].tier, 'shared')
})

test('no worktree with a devtrees.yaml: no rows, devtrees never runs, status bar hidden', async () => {
  const runner = machine()
  runner.files.clear()
  const w = await start(runner)
  const view = await w.request('stack.get', {})
  assert.equal(view.kind, 'ok')
  assert.deepEqual(view.repos, [])
  assert.deepEqual(runner.devtrees, [])
  assert.equal(statusUpdates(w).at(-1)?.visible, false)
})

test('runs the executables from the settings', async () => {
  const runner = machine()
  const w = await start(runner, {
    settings: { devtreesPath: '/opt/devtrees/bin/devtrees', orcaPath: '/Applications/Orca.app/bin/orca' }
  })
  const view = await w.request('stack.get', {})
  assert.ok(runner.devtrees.every((c) => c.executable === '/opt/devtrees/bin/devtrees'))
  assert.equal(view.executable, '/opt/devtrees/bin/devtrees')
  assert.deepEqual(lookups(runner, 'terminal')[0], {
    executable: '/Applications/Orca.app/bin/orca',
    args: ['terminal', 'list', '--json'],
    cwd: '/',
    detached: false
  })
})

test('reports a missing executable', async () => {
  const runner = machine().on('ls', { code: null, notFound: true, stderr: 'spawn devtrees ENOENT' })
  const w = await start(runner)
  assert.equal((await w.request('stack.get', {})).kind, 'not-installed')
  assert.equal(statusUpdates(w).at(-1)?.text, 'devtrees: not found')
})

test('asks for an upgrade when devtrees lacks ls --services', async () => {
  const runner = machine().on('ls', {
    code: 1,
    stdout: 'Unknown Syntax Error: Unsupported option name ("--services").\n\n$ devtrees ls [--json]\n'
  })
  const w = await start(runner)
  assert.equal((await w.request('stack.get', {})).kind, 'too-old')
  assert.equal(statusUpdates(w).at(-1)?.text, 'devtrees: upgrade')
})

test('a failed ls marks only its repo', async () => {
  const runner = machine()
  const w = await start(runner)
  runner.on('ls', (call) =>
    runner.commonDirs.get(call.cwd) === OTHER_GIT ? fail('CONFIG_INVALID', 'devtrees.yaml is malformed') : ok({ ls: { instances: [] } })
  )
  const view = await w.request('stack.get', {})
  const [app, other] = view.repos
  assert.equal(app.kind, 'ok')
  assert.equal(other.kind, 'error')
  assert.equal(other.message, 'CONFIG_INVALID: devtrees.yaml is malformed')
  assert.equal(other.rows[0].stack, null)
})

// Actions run in the pressed row's path.

test('an action runs in the pressed row even when focus is on another row', async () => {
  const runner = machine()
  const w = await start(runner)
  const view = await w.request('stack.get', {})
  assert.equal(view.focusedId, FEATURE_ROW.id)

  assert.deepEqual(await w.request('stack.action', { workspaceId: OTHER_ROW.id, action: 'down' }), { started: true, reason: null })
  await until(() => runner.commands.includes('down --json'), 'down')
  assert.deepEqual(actionCalls(runner), [{ executable: 'devtrees', args: ['down', '--json'], cwd: OTHER, detached: true }])
})

test('an action runs in the pressed row when focus does not resolve', async () => {
  const runner = machine()
  const w = await start(runner, { context: twins })
  const view = await w.request('stack.get', {})
  assert.equal(view.focusedId, null)
  await w.request('stack.action', { workspaceId: MAIN_ROW.id, action: 'up' })
  await until(() => runner.commands.some((c) => c.startsWith('up')), 'up')
  assert.deepEqual(actionCalls(runner), [{ executable: 'devtrees', args: ['up', '--no-attach', '--json'], cwd: MAIN_PATH, detached: true }])
})

test('refuses an action for a workspace that is gone, remote, or has no devtrees.yaml', async () => {
  const runner = machine()
  const w = await start(runner)
  await w.request('stack.get', {})
  const tries = [
    ['identity:wt2:local:unknown', /no longer open/],
    [REMOTE_ROW.id, /Only local worktrees/],
    [BARE_ROW.id, /no devtrees\.yaml/]
  ] as const
  for (const [workspaceId, reason] of tries) {
    const answer = await w.request('stack.action', { workspaceId, action: 'up' })
    assert.equal(answer.started, false)
    assert.match(answer.reason ?? '', reason)
  }
  assert.deepEqual(actionCalls(runner), [])
})

test('busy state is per row: one row up does not lock the others', async () => {
  const runner = machine()
  runner.hold = true
  const w = await start(runner)
  await w.request('stack.get', {})

  assert.equal((await w.request('stack.action', { workspaceId: MAIN_ROW.id, action: 'up' })).started, true)
  await until(() => lastPost(w) !== undefined && rowAt(lastPost(w), MAIN_PATH).busy !== null, 'busy post')
  assert.equal(rowAt(lastPost(w), MAIN_PATH).busy?.action, 'up')
  assert.equal(rowAt(lastPost(w), PATH).busy, null)
  assert.equal(rowAt(lastPost(w), OTHER).busy, null)
  // The same row is locked; another row of the same repo and one of another repo are not.
  assert.deepEqual(await w.request('stack.action', { workspaceId: MAIN_ROW.id, action: 'down' }), {
    started: false,
    reason: 'Another action is still running in this worktree.'
  })
  assert.equal((await w.request('stack.action', { workspaceId: FEATURE_ROW.id, action: 'up' })).started, true)
  assert.equal((await w.request('stack.action', { workspaceId: OTHER_ROW.id, action: 'down' })).started, true)
  await until(() => actionCalls(runner).length === 3, 'three actions')

  runner.release()
  await until(() => lastPost(w).repos.every((r) => r.rows.every((x) => x.busy === null)), 'all done')
  assert.deepEqual(
    actionCalls(runner).map((c) => [c.args[0], c.cwd]),
    [['up', MAIN_PATH], ['up', PATH], ['down', OTHER]]
  )
})

test('a refresh skips the repo with a running action, and reads it when the action ends', async () => {
  const runner = machine()
  runner.hold = true
  const w = await start(runner)
  await w.request('stack.get', {})
  await w.request('stack.action', { workspaceId: FEATURE_ROW.id, action: 'up' })
  await until(() => actionCalls(runner).length === 1, 'up started')
  const app = lsIn(runner, APP_GIT)
  const other = lsIn(runner, OTHER_GIT)

  await w.emit('workspace.changed', { context: focused })
  assert.equal(lsIn(runner, APP_GIT), app)
  assert.equal(lsIn(runner, OTHER_GIT), other + 1)

  runner.running.push(PATH)
  runner.release()
  await until(() => rowAt(lastPost(w), PATH).busy === null, 'up done')
  assert.equal(rowAt(lastPost(w), PATH).stack?.status, 'up')
  assert.equal(lsIn(runner, APP_GIT), app + 1)
  // Only the action's repo is read again when it ends.
  assert.equal(lsIn(runner, OTHER_GIT), other + 1)
})

test('a failed action shows its error code and message on its row', async () => {
  const runner = machine().on('up', fail('HEALTH_TIMEOUT', 'web did not become healthy'))
  const w = await start(runner)
  await w.request('stack.action', { workspaceId: FEATURE_ROW.id, action: 'up' })
  await until(() => lastPost(w) !== undefined && rowAt(lastPost(w), PATH).lastError !== null && rowAt(lastPost(w), PATH).busy === null, 'error post')
  assert.deepEqual(
    { ...rowAt(lastPost(w), PATH).lastError, at: 0 },
    { action: 'up', code: 'HEALTH_TIMEOUT', message: 'web did not become healthy', at: 0 }
  )
  assert.equal(rowAt(lastPost(w), MAIN_PATH).lastError, null)
})

test('restart is down, then up with the namespaces the stack had booted', async () => {
  const runner = machine()
  const w = await start(runner)
  await w.request('stack.action', { workspaceId: MAIN_ROW.id, action: 'restart' })
  await until(() => runner.commands.some((c) => c.startsWith('up')), 'up')
  assert.deepEqual(
    actionCalls(runner).map((c) => [c.args.join(' '), c.cwd]),
    [['down --json', MAIN_PATH], ['up -n default -n app --no-attach --json', MAIN_PATH]]
  )
})

test('restart does not start up again when down fails', async () => {
  const runner = machine().on('down', fail('DOWN_TIMEOUT', 'stuck'))
  const w = await start(runner)
  await w.request('stack.action', { workspaceId: MAIN_ROW.id, action: 'restart' })
  await until(() => lastPost(w) !== undefined && rowAt(lastPost(w), MAIN_PATH).lastError?.code === 'DOWN_TIMEOUT', 'down error')
  assert.deepEqual(actionCalls(runner).map((c) => c.args.join(' ')), ['down --json'])
})

test('restarts one isolated service of the pressed row, and refuses names its stack does not have', async () => {
  const runner = machine()
  const w = await start(runner)
  assert.deepEqual(await w.request('stack.action', { workspaceId: MAIN_ROW.id, action: 'restart-service', service: 'cache' }), {
    started: false,
    reason: 'No isolated service named cache.'
  })
  // feature-x is down: it runs no web.
  assert.equal((await w.request('stack.action', { workspaceId: FEATURE_ROW.id, action: 'restart-service', service: 'web' })).started, false)
  await w.request('stack.action', { workspaceId: OTHER_ROW.id, action: 'restart-service', service: 'web' })
  await until(() => runner.commands.includes('restart web --json'), 'restart web')
  assert.equal(runner.calls.find((c) => c.args[0] === 'restart')?.cwd, OTHER)
})

// Terminals: attach and logs.

const hostCreated = (w: TestWorker) => w.host.callsOf('terminal.create') as { workspaceId: string; title: string; command: string }[]
/** The terminals opened through the orca CLI, as the worktree path, title and command it got. */
const created = (runner: FakeRunner) =>
  runner.calls
    .filter((c) => c.args[0] === 'terminal' && c.args[1] === 'create')
    .map((c) => ({
      path: c.args[c.args.indexOf('--worktree') + 1].replace(/^path:/, ''),
      title: c.args[c.args.indexOf('--title') + 1],
      command: c.args[c.args.indexOf('--command') + 1]
    }))

test('Attach and Logs open a terminal in the pressed row, whatever is focused', async () => {
  const runner = machine()
  const w = await start(runner)
  assert.equal((await w.request('stack.get', {})).focusedId, FEATURE_ROW.id)
  const opens = [
    { workspaceId: OTHER_ROW.id, what: 'attach' },
    { workspaceId: OTHER_ROW.id, what: 'logs' },
    { workspaceId: MAIN_ROW.id, what: 'logs', service: 'web' },
    { workspaceId: MAIN_ROW.id, what: 'attach', shared: true },
    { workspaceId: MAIN_ROW.id, what: 'logs', service: 'cache', shared: true }
  ] as const
  for (const input of opens) assert.deepEqual(await w.request('terminal.open', input), { started: true, reason: null })
  assert.deepEqual(created(runner), [
    { path: OTHER, title: 'devtrees attach (main)', command: 'devtrees attach' },
    { path: OTHER, title: 'devtrees logs (main)', command: 'devtrees logs -f --all' },
    { path: MAIN_PATH, title: 'devtrees logs web (main)', command: 'devtrees logs -f web' },
    { path: MAIN_PATH, title: 'devtrees attach --shared (app)', command: 'devtrees attach --shared' },
    { path: MAIN_PATH, title: 'devtrees logs --shared cache (app)', command: 'devtrees logs -f --shared cache' }
  ])
  assert.deepEqual(hostCreated(w), [])
  assert.deepEqual(w.refusals, [])
  // Nothing runs devtrees in the worker for these.
  assert.deepEqual(actionCalls(runner), [])
})

test('a terminal opens in the pressed row when focus does not resolve', async () => {
  const runner = machine()
  const w = await start(runner, { context: twins })
  await w.request('terminal.open', { workspaceId: FEATURE_ROW.id, what: 'logs', service: 'worker' })
  assert.deepEqual(created(runner), [{ path: PATH, title: 'devtrees logs worker (feature-x)', command: 'devtrees logs -f worker' }])
})

test('quotes the executable and odd service names', async () => {
  const runner = machine()
  const w = await start(runner, { settings: { devtreesPath: "/opt/my tools/devtrees" } })
  await w.request('terminal.open', { workspaceId: FEATURE_ROW.id, what: 'logs', service: "it's; rm -rf ~" })
  await w.request('terminal.open', { workspaceId: FEATURE_ROW.id, what: 'logs', service: '$(touch x)`y`' })
  assert.deepEqual(created(runner).map((c) => c.command), [
    `'/opt/my tools/devtrees' logs -f 'it'\\''s; rm -rf ~'`,
    `'/opt/my tools/devtrees' logs -f '$(touch x)\`y\`'`
  ])
})

test('refuses a terminal for a workspace that is gone, remote, or has no devtrees.yaml', async () => {
  const runner = machine()
  const w = await start(runner)
  for (const [workspaceId, reason] of [
    ['identity:wt2:local:unknown', /no longer open/],
    [REMOTE_ROW.id, /Only local worktrees/],
    [BARE_ROW.id, /no devtrees\.yaml/]
  ] as const) {
    const answer = await w.request('terminal.open', { workspaceId, what: 'attach' })
    assert.equal(answer.started, false)
    assert.match(answer.reason ?? '', reason)
  }
  assert.equal((await w.request('terminal.open', { workspaceId: MAIN_ROW.id, what: 'attach', service: 'web' })).started, false)
  assert.deepEqual(created(runner), [])
  assert.deepEqual(hostCreated(w), [])
})

test('opens a visible, focused tab with this exact orca argv', async () => {
  const runner = machine()
  const w = await start(runner, { settings: { orcaPath: '/opt/orca' } })
  await w.request('terminal.open', { workspaceId: FEATURE_ROW.id, what: 'attach' })
  const call = runner.calls.find((c) => c.args[0] === 'terminal' && c.args[1] === 'create')
  assert.equal(call?.executable, '/opt/orca')
  assert.deepEqual(call?.args, [
    'terminal', 'create', '--worktree', `path:${PATH}`,
    '--title', 'devtrees attach (feature-x)', '--command', 'devtrees attach', '--focus', '--json'
  ])
  assert.deepEqual(hostCreated(w), [])
})

test('falls back to the host terminal.create when the orca CLI fails or is not ok', async () => {
  for (const mode of ['fail', 'not-ok'] as const) {
    const runner = machine()
    runner.terminalCreate = mode
    const w = await start(runner)
    assert.deepEqual(await w.request('terminal.open', { workspaceId: FEATURE_ROW.id, what: 'attach' }), { started: true, reason: null })
    assert.deepEqual(hostCreated(w), [{ workspaceId: FEATURE_ROW.id, title: 'devtrees attach (feature-x)', command: 'devtrees attach' }])
  }
})

test('reports a terminal Orca could not open', async () => {
  const runner = machine()
  runner.terminalCreate = 'fail'
  const w = await start(runner)
  w.host.respond('terminal.create', () => {
    throw new Error('no window')
  })
  const answer = await w.request('terminal.open', { workspaceId: MAIN_ROW.id, what: 'attach' })
  assert.equal(answer.started, false)
  assert.match(answer.reason ?? '', /Could not open a terminal/)
})

// Focus only highlights.

test('a terminal match highlights the right one of two "main" rows', async () => {
  const runner = machine()
  const w = await start(runner, { context: ctx('main', 'main', ['term_other']) })
  const view = await w.request('stack.get', {})
  assert.equal(view.focusedId, OTHER_ROW.id)
  assert.equal(view.focusUnknown, false)
  assert.equal(statusUpdates(w).at(-1)?.text, 'devtrees: up · web :38176')
})

test('without terminals, "main" on main matches two rows: nothing is highlighted', async () => {
  const runner = machine()
  const w = await start(runner, { context: twins })
  const view = await w.request('stack.get', {})
  assert.equal(view.focusedId, null)
  assert.equal(view.repos.length, 2)
  assert.equal(statusUpdates(w).at(-1)?.visible, false)
  // The orca CLI is not run without terminals to match.
  assert.deepEqual(lookups(runner, 'terminal'), [])
})

test('without terminals, a unique name and branch is highlighted', async () => {
  const runner = machine()
  const w = await start(runner, { context: ctx('feature-x', 'feature-x') })
  assert.equal((await w.request('stack.get', {})).focusedId, FEATURE_ROW.id)
  assert.equal(statusUpdates(w).at(-1)?.text, 'devtrees: down')
})

test('when the orca CLI fails, only the highlight is affected', async () => {
  const runner = machine()
  runner.terminals = null
  const w = await start(runner, { context: ctx('main', 'main', ['term_main']) })
  const view = await w.request('stack.get', {})
  assert.equal(view.focusedId, null)
  assert.equal(view.focusUnknown, true)
  assert.ok(w.logs.some((l) => /orca terminal list failed/.test(l)))
  assert.equal(view.repos.length, 2)
  assert.equal((await w.request('stack.action', { workspaceId: MAIN_ROW.id, action: 'down' })).started, true)
})

test('a focused workspace without a devtrees.yaml highlights nothing and hides the status bar item', async () => {
  const runner = machine()
  const w = await start(runner, { context: ctx('no-config', 'no-config') })
  assert.equal((await w.request('stack.get', {})).focusedId, null)
  assert.equal(statusUpdates(w).at(-1)?.visible, false)
})

test('follows workspace.changed to the newly focused row, even with the same payload', async () => {
  const runner = machine()
  const context = ctx('main', 'main', ['term_shared'])
  runner.terminals = [terminal('term_shared', MAIN_PATH)]
  const w = await start(runner, { context })
  await w.emit('workspace.changed', { context })
  assert.equal(lastPost(w).focusedId, MAIN_ROW.id)
  runner.terminals = [terminal('term_shared', OTHER)]
  await w.emit('workspace.changed', { context })
  assert.equal(lastPost(w).focusedId, OTHER_ROW.id)
  await w.emit('workspace.changed', { context: null })
  assert.equal(lastPost(w).focusedId, null)
})

test('the status bar follows the focused row', async () => {
  const runner = machine()
  runner.running = [MAIN_PATH, PATH, OTHER]
  const w = await start(runner)
  await w.request('stack.get', {})
  // feature-x is the second running worktree of app.
  assert.equal(statusUpdates(w).at(-1)?.text, 'devtrees: up · web :38276')
})

// Prune.

/** Starts with the removed worktree still listed, then removes it as Orca would. */
async function startThenRemove(runner: FakeRunner, removed: typeof GONE_ROW, remaining: unknown[]) {
  const workspaces = { list: [...remaining, removed] }
  const w = await start(runner, { workspaces })
  await until(() => lookups(runner, 'rev-parse').length >= workspaces.list.length, 'repo index')
  workspaces.list = remaining
  await w.emit('workspace.removed', { workspaceId: removed.id, kind: 'worktree', path: removed.path })
  return w
}

test('prunes only from a surviving worktree of the removed worktree repo', async () => {
  const runner = machine().on('prune', ok({ prune: { pruned: [] } }))
  runner.files.delete(`${MAIN_PATH}/devtrees.yaml`)
  await startThenRemove(runner, GONE_ROW, [MAIN_ROW, FEATURE_ROW, OTHER_ROW])
  // feature-x has a devtrees.yaml and shares the repo; the other repo is never touched.
  assert.deepEqual(prunes(runner), [{ executable: 'devtrees', args: ['prune', '--json'], cwd: PATH, detached: true }])
})

test('uses a worktree of the same repo even without a devtrees.yaml', async () => {
  const runner = machine().on('prune', ok({ prune: { pruned: [] } }))
  runner.files.delete(`${MAIN_PATH}/devtrees.yaml`)
  await startThenRemove(runner, GONE_ROW, [MAIN_ROW, OTHER_ROW])
  assert.deepEqual(prunes(runner).map((c) => c.cwd), [MAIN_PATH])
})

test('skips the prune when no worktree of the repo is left', async () => {
  const runner = machine().on('prune', ok({ prune: { pruned: [] } }))
  const w = await startThenRemove(runner, GONE_ROW, [OTHER_ROW])
  assert.deepEqual(prunes(runner), [])
  assert.ok(w.logs.some((l) => /prune skipped: no other worktree/.test(l)))
})

test('skips the prune for a worktree it never saw, and prunes nothing else', async () => {
  const runner = machine().on('prune', ok({ prune: { pruned: [] } }))
  const w = await start(runner)
  await w.request('stack.get', {})
  await w.emit('workspace.removed', { workspaceId: 'identity:wt2:local:unknown', kind: 'worktree', path: '/work/app/unseen' })
  assert.deepEqual(prunes(runner), [])
  assert.ok(w.logs.some((l) => /prune skipped: \/work\/app\/unseen was not seen/.test(l)))
})

test('ignores removed folder workspaces', async () => {
  const runner = machine()
  const w = await start(runner)
  await w.emit('workspace.removed', { workspaceId: 'identity:folder:x', kind: 'folder', path: '/x' })
  assert.equal(prunes(runner).length, 0)
})

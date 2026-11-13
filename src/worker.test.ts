// The worker over a mocked devtrees CLI: src/fake-runner.ts stands in for it, for the orca and
// git CLIs, and for the file system.
import { afterEach, assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import { FakeRunner, fail, idOf, lsEmpty, lsRunning, ok, terminal, until } from './fake-runner'
import type { StackView } from './protocol'
import * as main from './worker'

const PATH = '/work/app/feature-x'
const MAIN_PATH = '/work/app/main'
const GONE = '/work/app/gone'
const OTHER = '/elsewhere/main'
const APP_GIT = '/work/app/main/.git'
const OTHER_GIT = '/elsewhere/main/.git'

// Orca's ids carry no repo or path.
const row = (n: number, name: string, path: string, branch: string) => ({
  id: `identity:wt2:local:0000000${n}`,
  kind: 'worktree' as const,
  name,
  path,
  branch: `refs/heads/${branch}`,
  hostId: 'local'
})
const MAIN_ROW = row(1, 'main', MAIN_PATH, 'main')
const FEATURE_ROW = row(2, 'feature-x', PATH, 'feature-x')
const OTHER_ROW = row(3, 'main', OTHER, 'main')
const GONE_ROW = row(4, 'gone', GONE, 'gone')

const ctx = (displayName: string, branch: string, terminals: string[] = []) => ({
  displayName,
  branch,
  terminals: terminals.map((id) => ({ id, title: 'zsh' }))
})
/** The focused worktree, named and found by its terminal. */
const focused = ctx('feature-x', 'feature-x', ['term_feature'])
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

/** A runner where each worktree knows its repo and the feature-x terminal is listed. */
function machine(): FakeRunner {
  const runner = new FakeRunner()
  runner.terminals = [terminal('term_feature', PATH), terminal('term_main', MAIN_PATH), terminal('term_other', OTHER)]
  for (const path of [MAIN_PATH, PATH, GONE]) runner.commonDirs.set(path, APP_GIT)
  runner.commonDirs.set(OTHER, OTHER_GIT)
  return runner
}

async function start(runner: FakeRunner, options: Start = {}) {
  main.setRunner(runner)
  const workspaces = options.workspaces ?? { list: [MAIN_ROW, FEATURE_ROW, OTHER_ROW] }
  const host = mockHost({
    results: {
      'workspace.readContext': options.context === undefined ? focused : options.context,
      'workspace.list': () => ({ workspaces: workspaces.list, truncated: false }),
      'statusBar.update': { ok: true }
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

test('lists the focused worktree stack and the shared instance', async () => {
  const runner = machine().on('ls', ok(lsRunning(PATH)))
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  const view = await w.request('stack.get', {})

  assert.equal(view.kind, 'ok')
  assert.equal(view.workspace?.path, PATH)
  assert.equal(view.resolvedBy, 'terminals')
  assert.equal(view.stack?.status, 'up')
  assert.equal(view.stack?.id, idOf(PATH))
  assert.deepEqual(view.stack?.services.map((s) => s.name), ['web', 'worker'])
  assert.deepEqual(view.stack?.services[0].ports, [{ name: 'WEB_PORT', port: 38176 }])
  assert.equal(view.shared?.services[0].tier, 'shared')
  // Plain JSON: nothing undefined.
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view)

  assert.deepEqual(runner.devtrees[0], { executable: 'devtrees', args: ['ls', '--services', '--json'], cwd: PATH, detached: false })
  assert.equal(statusUpdates(w).at(-1)?.text, 'devtrees: up · web :38176')
  assert.deepEqual(w.refusals, [])
})

test('runs the executables from the settings', async () => {
  const runner = machine().on('ls', ok(lsEmpty))
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner, {
    settings: { devtreesPath: '/opt/devtrees/bin/devtrees', orcaPath: '/Applications/Orca.app/bin/orca' }
  })
  const view = await w.request('stack.get', {})
  assert.equal(runner.devtrees[0].executable, '/opt/devtrees/bin/devtrees')
  assert.equal(view.executable, '/opt/devtrees/bin/devtrees')
  assert.deepEqual(lookups(runner, 'terminal')[0], {
    executable: '/Applications/Orca.app/bin/orca',
    args: ['terminal', 'list', '--json'],
    cwd: '/',
    detached: false
  })
  assert.equal(view.stack?.status, 'down')
  assert.equal(statusUpdates(w).at(-1)?.text, 'devtrees: down')
})

test('hides the status bar item without a devtrees.yaml and never runs devtrees', async () => {
  const runner = machine()
  const w = await start(runner)
  const view = await w.request('stack.get', {})
  assert.equal(view.kind, 'no-config')
  assert.deepEqual(runner.devtrees, [])
  assert.equal(statusUpdates(w).at(-1)?.visible, false)
})

test('reports no workspace when none is focused', async () => {
  const w = await start(machine(), { context: null })
  assert.equal((await w.request('stack.get', {})).kind, 'no-workspace')
})

test('reports a missing executable', async () => {
  const runner = machine().on('ls', { code: null, notFound: true, stderr: 'spawn devtrees ENOENT' })
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  assert.equal((await w.request('stack.get', {})).kind, 'not-installed')
  assert.equal(statusUpdates(w).at(-1)?.text, 'devtrees: not found')
})

test('asks for an upgrade when devtrees lacks ls --services', async () => {
  const runner = machine().on('ls', {
    code: 1,
    stdout: 'Unknown Syntax Error: Unsupported option name ("--services").\n\n$ devtrees ls [--json]\n'
  })
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  assert.equal((await w.request('stack.get', {})).kind, 'too-old')
  assert.equal(statusUpdates(w).at(-1)?.text, 'devtrees: upgrade')
})

test('shows the JSON error envelope of a failed ls', async () => {
  const runner = machine().on('ls', fail('CONFIG_INVALID', 'devtrees.yaml is malformed'))
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  const view = await w.request('stack.get', {})
  assert.equal(view.kind, 'error')
  assert.equal(view.message, 'CONFIG_INVALID: devtrees.yaml is malformed')
})

test('marks a stack with a dead service as degraded', async () => {
  const runner = machine().on('ls', ok(lsRunning(PATH, { dead: ['web'] })))
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  assert.equal((await w.request('stack.get', {})).stack?.status, 'partial')
  assert.equal(statusUpdates(w).at(-1)?.text, 'devtrees: 1 dead · web')
})

test('up runs detached in the background and reports progress, then the result', async () => {
  let running = false
  const runner = machine()
    .on('ls', () => ok(running ? lsRunning(PATH) : lsEmpty))
    .on('up', () => {
      running = true
      return ok({ up: {} })
    })
  runner.files.add(`${PATH}/devtrees.yaml`)
  runner.hold = true
  const w = await start(runner)
  await w.request('stack.get', {})

  assert.deepEqual(await w.request('stack.action', { action: 'up' }), { started: true, reason: null })
  await until(() => lastPost(w)?.busy !== null, 'busy post')
  assert.equal(lastPost(w).busy?.action, 'up')
  assert.equal(statusUpdates(w).at(-1)?.text, 'devtrees: starting')
  // A second press while it runs does not start another.
  assert.deepEqual(await w.request('stack.action', { action: 'down' }), { started: false, reason: 'Another action is still running.' })

  runner.release()
  await until(() => lastPost(w)?.busy === null && lastPost(w)?.stack?.status === 'up', 'up result')
  const up = runner.calls.find((c) => c.args[0] === 'up')
  assert.deepEqual(up, { executable: 'devtrees', args: ['up', '--no-attach', '--json'], cwd: PATH, detached: true })
  assert.equal(statusUpdates(w).at(-1)?.text, 'devtrees: up · web :38176')
})

test('a failed action shows its error code and message', async () => {
  const runner = machine()
    .on('ls', ok(lsEmpty))
    .on('up', fail('HEALTH_TIMEOUT', 'web did not become healthy'))
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  await w.request('stack.action', { action: 'up' })
  await until(() => lastPost(w)?.lastError !== null && lastPost(w)?.busy === null, 'error post')
  assert.deepEqual(
    { ...lastPost(w).lastError, at: 0 },
    { action: 'up', code: 'HEALTH_TIMEOUT', message: 'web did not become healthy', at: 0 }
  )
})

test('restart is down, then up with the namespaces the stack had booted', async () => {
  const runner = machine().on('ls', ok(lsRunning(PATH)))
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  await w.request('stack.action', { action: 'restart' })
  await until(() => runner.commands.some((c) => c.startsWith('up')), 'up')
  const actions = runner.commands.filter((c) => !c.startsWith('ls'))
  assert.deepEqual(actions, ['down --json', 'up -n default -n app --no-attach --json'])
})

test('restart does not start up again when down fails', async () => {
  const runner = machine().on('ls', ok(lsRunning(PATH))).on('down', fail('DOWN_TIMEOUT', 'stuck'))
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  await w.request('stack.action', { action: 'restart' })
  await until(() => lastPost(w)?.lastError?.code === 'DOWN_TIMEOUT', 'down error')
  assert.deepEqual(runner.commands.filter((c) => !c.startsWith('ls')), ['down --json'])
})

test('restarts one isolated service, and refuses names the stack does not have', async () => {
  const runner = machine().on('ls', ok(lsRunning(PATH)))
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  assert.deepEqual(await w.request('stack.action', { action: 'restart-service', service: 'cache' }), {
    started: false,
    reason: 'No isolated service named cache.'
  })
  await w.request('stack.action', { action: 'restart-service', service: 'web' })
  await until(() => runner.commands.includes('restart web --json'), 'restart web')
})

// Which worktree is focused.

test('a terminal match picks the right one of two worktrees with the same name and branch', async () => {
  const runner = machine().on('ls', ok(lsRunning(OTHER)))
  runner.files.add(`${MAIN_PATH}/devtrees.yaml`)
  runner.files.add(`${OTHER}/devtrees.yaml`)
  const w = await start(runner, { context: ctx('main', 'main', ['term_other']) })
  const view = await w.request('stack.get', {})
  assert.equal(view.kind, 'ok')
  assert.equal(view.workspace?.path, OTHER)
  assert.equal(view.workspace?.id, OTHER_ROW.id)
  assert.equal(view.resolvedBy, 'terminals')
  assert.deepEqual(view.candidates, [])
  assert.ok(runner.devtrees.every((c) => c.cwd === OTHER))
  await w.request('stack.action', { action: 'down' })
  await until(() => runner.commands.includes('down --json'), 'down')
  assert.equal(runner.calls.find((c) => c.args[0] === 'down')?.cwd, OTHER)
})

test('terminals in two worktrees are ambiguous: nothing runs until a pick', async () => {
  const runner = machine()
  runner.files.add(`${MAIN_PATH}/devtrees.yaml`)
  runner.files.add(`${OTHER}/devtrees.yaml`)
  const w = await start(runner, { context: ctx('main', 'main', ['term_main', 'term_other']) })
  const view = await w.request('stack.get', {})
  assert.equal(view.kind, 'unresolved')
  assert.equal(view.workspace, null)
  assert.deepEqual(view.candidates.map((c) => c.path), [MAIN_PATH, OTHER])
  assert.equal(statusUpdates(w).at(-1)?.visible, false)
  const refused = await w.request('stack.action', { action: 'up' })
  assert.equal(refused.started, false)
  assert.match(refused.reason ?? '', /Pick the worktree/)
  assert.deepEqual(runner.devtrees, [])
})

test('without terminals, a unique name and branch is used', async () => {
  const runner = machine().on('ls', ok(lsEmpty))
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner, { context: ctx('feature-x', 'feature-x') })
  const view = await w.request('stack.get', {})
  assert.equal(view.kind, 'ok')
  assert.equal(view.workspace?.path, PATH)
  assert.equal(view.resolvedBy, 'name')
  // No terminals to match: the orca CLI is not run.
  assert.deepEqual(lookups(runner, 'terminal'), [])
})

test('without terminals, an ambiguous name and branch shows the picker and refuses actions', async () => {
  const runner = machine().on('ls', ok(lsEmpty))
  runner.files.add(`${MAIN_PATH}/devtrees.yaml`)
  runner.files.add(`${OTHER}/devtrees.yaml`)
  const w = await start(runner, { context: twins })
  const view = await w.request('stack.get', {})
  assert.equal(view.kind, 'unresolved')
  assert.deepEqual(view.candidates.map((c) => c.path), [MAIN_PATH, OTHER])
  assert.deepEqual(view.candidates.map((c) => c.branch), ['main', 'main'])
  assert.notEqual(view.message, null)
  for (const action of ['up', 'down', 'restart'] as const) {
    assert.equal((await w.request('stack.action', { action })).started, false)
  }
  assert.equal((await w.request('stack.action', { action: 'restart-service', service: 'web' })).started, false)
  assert.deepEqual(runner.devtrees, [])
  assert.equal(statusUpdates(w).at(-1)?.visible, false)
})

test('when the orca CLI fails, falls back to the name and branch', async () => {
  const runner = machine().on('ls', ok(lsEmpty))
  runner.terminals = null
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  const view = await w.request('stack.get', {})
  assert.equal(view.kind, 'ok')
  assert.equal(view.workspace?.path, PATH)
  assert.equal(view.resolvedBy, 'name')
  assert.ok(w.logs.some((l) => /orca terminal list failed/.test(l)))
})

test('when the orca CLI fails and the name is ambiguous, nothing is chosen', async () => {
  const runner = machine()
  runner.terminals = null
  runner.files.add(`${MAIN_PATH}/devtrees.yaml`)
  const w = await start(runner, { context: ctx('main', 'main', ['term_main']) })
  assert.equal((await w.request('stack.get', {})).kind, 'unresolved')
  assert.equal((await w.request('stack.action', { action: 'up' })).started, false)
})

test('no match at all offers every local worktree', async () => {
  const w = await start(machine(), { context: ctx('unknown', 'nowhere') })
  const view = await w.request('stack.get', {})
  assert.equal(view.kind, 'unresolved')
  assert.deepEqual(view.candidates.map((c) => c.path), [MAIN_PATH, PATH, OTHER])
})

test('a pick unlocks actions until focus moves', async () => {
  const runner = machine().on('ls', ok(lsEmpty))
  runner.files.add(`${MAIN_PATH}/devtrees.yaml`)
  runner.files.add(`${OTHER}/devtrees.yaml`)
  const w = await start(runner, { context: twins })
  await w.request('stack.get', {})
  const picked = await w.request('workspace.pick', { workspaceId: OTHER_ROW.id })
  assert.equal(picked.kind, 'ok')
  assert.equal(picked.workspace?.path, OTHER)
  assert.equal(picked.resolvedBy, 'pick')
  assert.equal(picked.candidates.length, 2)

  assert.equal((await w.request('stack.action', { action: 'up' })).started, true)
  await until(() => runner.commands.some((c) => c.startsWith('up')), 'up')
  assert.equal(runner.calls.find((c) => c.args[0] === 'up')?.cwd, OTHER)
  await until(() => lastPost(w)?.busy === null, 'up done')

  // The same payload again: it may be a move to the twin, so the pick is dropped.
  await w.emit('workspace.changed', { context: twins })
  assert.equal(lastPost(w).kind, 'unresolved')
  assert.equal((await w.request('stack.action', { action: 'up' })).started, false)
})

test('a pick is kept while the focused terminals stay the same', async () => {
  const runner = machine().on('ls', ok(lsEmpty))
  runner.terminals = null
  runner.files.add(`${OTHER}/devtrees.yaml`)
  const context = ctx('main', 'main', ['term_x'])
  const w = await start(runner, { context })
  await w.request('stack.get', {})
  await w.request('workspace.pick', { workspaceId: OTHER_ROW.id })
  await w.emit('workspace.changed', { context: ctx('main', 'main', ['term_x']) })
  assert.equal(lastPost(w).workspace?.path, OTHER)
  await w.emit('workspace.changed', { context: ctx('main', 'main', ['term_x', 'term_y']) })
  assert.equal(lastPost(w).kind, 'unresolved')
})

test('ignores a pick that is not among the candidates', async () => {
  const runner = machine()
  const w = await start(runner, { context: twins })
  await w.request('stack.get', {})
  const view = await w.request('workspace.pick', { workspaceId: FEATURE_ROW.id })
  assert.equal(view.kind, 'unresolved')
})

test('resolves again on every workspace.changed, even with the same payload', async () => {
  const runner = machine().on('ls', ok(lsEmpty))
  runner.files.add(`${MAIN_PATH}/devtrees.yaml`)
  runner.files.add(`${OTHER}/devtrees.yaml`)
  const context = ctx('main', 'main', ['term_shared'])
  runner.terminals = [terminal('term_shared', MAIN_PATH)]
  const w = await start(runner, { context })
  await w.emit('workspace.changed', { context })
  assert.equal(lastPost(w).workspace?.path, MAIN_PATH)
  runner.terminals = [terminal('term_shared', OTHER)]
  await w.emit('workspace.changed', { context })
  assert.equal(lastPost(w).workspace?.path, OTHER)
})

test('follows workspace.changed to the newly focused worktree', async () => {
  const runner = machine().on('ls', ok(lsEmpty))
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  await w.request('stack.get', {})
  await w.emit('workspace.changed', { context: ctx('main', 'main', ['term_main']) })
  assert.equal(lastPost(w).workspace?.path, MAIN_PATH)
  assert.equal(lastPost(w).kind, 'no-config')
})

test('a remote focused workspace is not supported', async () => {
  const runner = machine()
  runner.terminals = [terminal('term_ssh', '/home/me/app', 'ssh-host')]
  const w = await start(runner, { context: ctx('app', 'main', ['term_ssh']) })
  assert.equal((await w.request('stack.get', {})).kind, 'no-workspace')
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
  const runner = machine().on('ls', ok(lsEmpty)).on('prune', ok({ prune: { pruned: [] } }))
  runner.files.add(`${PATH}/devtrees.yaml`)
  runner.files.add(`${OTHER}/devtrees.yaml`)
  await startThenRemove(runner, GONE_ROW, [MAIN_ROW, FEATURE_ROW, OTHER_ROW])
  // feature-x has a devtrees.yaml and shares the repo; the other repo is never touched.
  assert.deepEqual(prunes(runner), [{ executable: 'devtrees', args: ['prune', '--json'], cwd: PATH, detached: true }])
})

test('uses a worktree of the same repo even without a devtrees.yaml', async () => {
  const runner = machine().on('ls', ok(lsEmpty)).on('prune', ok({ prune: { pruned: [] } }))
  runner.files.add(`${OTHER}/devtrees.yaml`)
  await startThenRemove(runner, GONE_ROW, [MAIN_ROW, OTHER_ROW])
  assert.deepEqual(prunes(runner).map((c) => c.cwd), [MAIN_PATH])
})

test('skips the prune when no worktree of the repo is left', async () => {
  const runner = machine().on('prune', ok({ prune: { pruned: [] } }))
  runner.files.add(`${OTHER}/devtrees.yaml`)
  const w = await startThenRemove(runner, GONE_ROW, [OTHER_ROW])
  assert.deepEqual(prunes(runner), [])
  assert.ok(w.logs.some((l) => /prune skipped: no other worktree/.test(l)))
})

test('skips the prune for a worktree it never saw, and prunes nothing else', async () => {
  const runner = machine().on('prune', ok({ prune: { pruned: [] } }))
  runner.files.add(`${PATH}/devtrees.yaml`)
  runner.files.add(`${OTHER}/devtrees.yaml`)
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

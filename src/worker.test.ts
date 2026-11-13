// The worker over a mocked devtrees CLI: src/fake-runner.ts stands in for it and the file system.
import { afterEach, assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import { FakeRunner, fail, idOf, lsEmpty, lsRunning, ok, until } from './fake-runner'
import type { StackView } from './protocol'
import * as main from './worker'

const REPO = 'repo-1'
const PATH = '/work/app/feature-x'
const MAIN_PATH = '/work/app/main'

const workspaces = [
  { id: `${REPO}::${MAIN_PATH}`, kind: 'worktree', name: 'main', path: MAIN_PATH, branch: 'refs/heads/main', hostId: 'local' },
  { id: `${REPO}::${PATH}`, kind: 'worktree', name: 'feature-x', path: PATH, branch: 'refs/heads/feature-x', hostId: 'local' },
  { id: `other::/elsewhere/main`, kind: 'worktree', name: 'main', path: '/elsewhere/main', branch: 'refs/heads/main', hostId: 'local' }
]
const focused = { branch: 'feature-x', displayName: 'feature-x', terminals: [] }

let worker: TestWorker | undefined
afterEach(async () => {
  await worker?.deactivate()
  worker = undefined
})

async function start(runner: FakeRunner, options: { context?: unknown; settings?: Record<string, string | number> } = {}) {
  main.setRunner(runner)
  const host = mockHost({
    results: {
      'workspace.readContext': options.context === undefined ? focused : options.context,
      'workspace.list': { workspaces, truncated: false },
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

test('lists the focused worktree stack and the shared instance', async () => {
  const runner = new FakeRunner().on('ls', ok(lsRunning(PATH)))
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  const view = await w.request('stack.get', {})

  assert.equal(view.kind, 'ok')
  assert.equal(view.workspace?.path, PATH)
  assert.equal(view.stack?.status, 'up')
  assert.equal(view.stack?.id, idOf(PATH))
  assert.deepEqual(view.stack?.services.map((s) => s.name), ['web', 'worker'])
  assert.deepEqual(view.stack?.services[0].ports, [{ name: 'WEB_PORT', port: 38176 }])
  assert.equal(view.shared?.services[0].tier, 'shared')
  // Plain JSON: nothing undefined.
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view)

  assert.deepEqual(runner.calls[0], { executable: 'devtrees', args: ['ls', '--services', '--json'], cwd: PATH, detached: false })
  assert.equal(statusUpdates(w).at(-1)?.text, 'devtrees: up · web :38176')
  assert.deepEqual(w.refusals, [])
})

test('runs the executable from the settings', async () => {
  const runner = new FakeRunner().on('ls', ok(lsEmpty))
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner, { settings: { devtreesPath: '/opt/devtrees/bin/devtrees' } })
  const view = await w.request('stack.get', {})
  assert.equal(runner.calls[0].executable, '/opt/devtrees/bin/devtrees')
  assert.equal(view.executable, '/opt/devtrees/bin/devtrees')
  assert.equal(view.stack?.status, 'down')
  assert.equal(statusUpdates(w).at(-1)?.text, 'devtrees: down')
})

test('hides the status bar item without a devtrees.yaml and never runs devtrees', async () => {
  const runner = new FakeRunner()
  const w = await start(runner)
  const view = await w.request('stack.get', {})
  assert.equal(view.kind, 'no-config')
  assert.deepEqual(runner.calls, [])
  assert.equal(statusUpdates(w).at(-1)?.visible, false)
})

test('reports no workspace when none is focused', async () => {
  const w = await start(new FakeRunner(), { context: null })
  assert.equal((await w.request('stack.get', {})).kind, 'no-workspace')
})

test('reports a missing executable', async () => {
  const runner = new FakeRunner().on('ls', { code: null, notFound: true, stderr: 'spawn devtrees ENOENT' })
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  assert.equal((await w.request('stack.get', {})).kind, 'not-installed')
  assert.equal(statusUpdates(w).at(-1)?.text, 'devtrees: not found')
})

test('asks for an upgrade when devtrees lacks ls --services', async () => {
  const runner = new FakeRunner().on('ls', {
    code: 1,
    stdout: 'Unknown Syntax Error: Unsupported option name ("--services").\n\n$ devtrees ls [--json]\n'
  })
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  assert.equal((await w.request('stack.get', {})).kind, 'too-old')
  assert.equal(statusUpdates(w).at(-1)?.text, 'devtrees: upgrade')
})

test('shows the JSON error envelope of a failed ls', async () => {
  const runner = new FakeRunner().on('ls', fail('CONFIG_INVALID', 'devtrees.yaml is malformed'))
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  const view = await w.request('stack.get', {})
  assert.equal(view.kind, 'error')
  assert.equal(view.message, 'CONFIG_INVALID: devtrees.yaml is malformed')
})

test('marks a stack with a dead service as degraded', async () => {
  const runner = new FakeRunner().on('ls', ok(lsRunning(PATH, { dead: ['web'] })))
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  assert.equal((await w.request('stack.get', {})).stack?.status, 'partial')
  assert.equal(statusUpdates(w).at(-1)?.text, 'devtrees: 1 dead · web')
})

test('up runs detached in the background and reports progress, then the result', async () => {
  let running = false
  const runner = new FakeRunner()
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
  const runner = new FakeRunner()
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
  const runner = new FakeRunner().on('ls', ok(lsRunning(PATH)))
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  await w.request('stack.action', { action: 'restart' })
  await until(() => runner.commands.some((c) => c.startsWith('up')), 'up')
  const actions = runner.commands.filter((c) => !c.startsWith('ls'))
  assert.deepEqual(actions, ['down --json', 'up -n default -n app --no-attach --json'])
})

test('restart does not start up again when down fails', async () => {
  const runner = new FakeRunner().on('ls', ok(lsRunning(PATH))).on('down', fail('DOWN_TIMEOUT', 'stuck'))
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  await w.request('stack.action', { action: 'restart' })
  await until(() => lastPost(w)?.lastError?.code === 'DOWN_TIMEOUT', 'down error')
  assert.deepEqual(runner.commands.filter((c) => !c.startsWith('ls')), ['down --json'])
})

test('restarts one isolated service, and refuses names the stack does not have', async () => {
  const runner = new FakeRunner().on('ls', ok(lsRunning(PATH)))
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  assert.deepEqual(await w.request('stack.action', { action: 'restart-service', service: 'cache' }), {
    started: false,
    reason: 'No isolated service named cache.'
  })
  await w.request('stack.action', { action: 'restart-service', service: 'web' })
  await until(() => runner.commands.includes('restart web --json'), 'restart web')
})

test('prunes from a worktree of the same repo when one is removed', async () => {
  const runner = new FakeRunner().on('ls', ok(lsEmpty)).on('prune', ok({ prune: { pruned: [] } }))
  const w = await start(runner)
  await w.emit('workspace.removed', { workspaceId: `${REPO}::/work/app/gone`, kind: 'worktree', path: '/work/app/gone' })
  const prunes = runner.calls.filter((c) => c.args[0] === 'prune')
  assert.deepEqual(prunes, [{ executable: 'devtrees', args: ['prune', '--json'], cwd: MAIN_PATH, detached: true }])
})

test('without a repo id, prunes in each worktree that has a devtrees.yaml', async () => {
  const runner = new FakeRunner().on('ls', ok(lsEmpty)).on('prune', ok({ prune: { pruned: [] } }))
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  await w.emit('workspace.removed', { workspaceId: 'plain-id', kind: 'worktree', path: '/work/app/gone' })
  assert.deepEqual(runner.calls.filter((c) => c.args[0] === 'prune').map((c) => c.cwd), [PATH])
})

test('ignores removed folder workspaces', async () => {
  const runner = new FakeRunner()
  const w = await start(runner)
  await w.emit('workspace.removed', { workspaceId: `${REPO}::/x`, kind: 'folder', path: '/x' })
  assert.equal(runner.calls.filter((c) => c.args[0] === 'prune').length, 0)
})

test('offers a choice when Orca context matches two workspaces', async () => {
  const runner = new FakeRunner().on('ls', ok(lsEmpty))
  runner.files.add(`${MAIN_PATH}/devtrees.yaml`)
  runner.files.add('/elsewhere/main/devtrees.yaml')
  const w = await start(runner, { context: { branch: 'main', displayName: 'main', terminals: [] } })
  const view = await w.request('stack.get', {})
  assert.deepEqual(view.candidates.map((c) => c.path), [MAIN_PATH, '/elsewhere/main'])
  assert.equal(view.workspace?.path, MAIN_PATH)
  const picked = await w.request('workspace.pick', { workspaceId: 'other::/elsewhere/main' })
  assert.equal(picked.workspace?.path, '/elsewhere/main')
})

test('follows workspace.changed to the newly focused worktree', async () => {
  const runner = new FakeRunner().on('ls', ok(lsEmpty))
  runner.files.add(`${PATH}/devtrees.yaml`)
  const w = await start(runner)
  await w.request('stack.get', {})
  await w.emit('workspace.changed', { context: { branch: 'main', displayName: 'main', terminals: [] } })
  // Two "main" workspaces, neither with a devtrees.yaml: the first is shown.
  assert.equal(lastPost(w).workspace?.path, MAIN_PATH)
  assert.equal(lastPost(w).kind, 'no-config')
})

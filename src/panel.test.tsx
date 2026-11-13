// The panel over a stand-in worker: what each plugin.request answers.
import { afterEach, assert, mockHost, mount, test, type TestPanel, type TreeSnapshot } from 'orca/testing'
import * as panel from './panel'
import type { InstanceView, RepoView, RowView, StackView } from './protocol'

const MAIN = 'identity:wt2:local:1'
const IDLE = 'identity:wt2:local:2'
const FEAT = 'identity:wt2:local:3'
const FIX = 'identity:wt2:local:4'
const OLD = 'identity:wt2:local:5'
const FIXTURE = '/w/devtrees-fixture/.git'
const DEMO = '/w/demo-app/.git'

const running = (id: string, port: number): InstanceView => ({
  status: 'up',
  id,
  namespaces: ['default'],
  services: [
    { name: 'web', status: 'Running', state: 'active', health: 'ready', tier: 'isolated', ports: [{ name: 'WEB_PORT', port }] },
    { name: 'worker', status: 'Completed', state: 'dead', health: 'unknown', tier: 'isolated', ports: [] }
  ]
})
const down = (id: string): InstanceView => ({ status: 'down', id, namespaces: [], services: [] })
const sharedOf = (name: string, port: number): InstanceView => ({
  status: 'up',
  id: 'shared',
  namespaces: ['default'],
  services: [{ name, status: 'Running', state: 'active', health: 'unknown', tier: 'shared', ports: [{ name: 'CACHE_PORT', port }] }]
})
const rowOf = (id: string, name: string, path: string, stack: InstanceView | null, branch: string | null = name): RowView => ({
  workspace: { id, name, path, branch, project: null },
  stack,
  busy: null,
  lastError: null
})

const fixture: RepoView = {
  key: FIXTURE,
  label: 'devtrees-fixture',
  kind: 'ok',
  message: null,
  shared: sharedOf('cache', 50000),
  rows: [rowOf(MAIN, 'main', '/w/devtrees-fixture', running('main-11111111', 41230)), rowOf(IDLE, 'idle', '/w/wt/idle', down('idle-22222222'))]
}
const demo: RepoView = {
  key: DEMO,
  label: 'demo-app',
  kind: 'ok',
  message: null,
  shared: sharedOf('db', 51000),
  rows: [
    rowOf(FEAT, 'feat-x', '/w/demo/feat-x', running('feat-x-33333333', 42230), 'feat/x'),
    rowOf(FIX, 'fix-y', '/w/demo/fix-y', running('fix-y-44444444', 42330)),
    rowOf(OLD, 'old', '/w/demo/old', down('old-55555555'))
  ]
}
// devtrees-fixture's main is focused and up; demo-app runs two worktrees and its shared instance.
const base: StackView = { kind: 'ok', repos: [fixture, demo], focusedId: MAIN, focusUnknown: false, executable: 'devtrees' }

let view: TestPanel | undefined
afterEach(async () => {
  await view?.unmount()
  view = undefined
})

function host(answer: StackView, actions: unknown[] = [], opens: unknown[] = []) {
  return mockHost({
    requests: {
      'stack.get': () => answer,
      'stack.action': (input) => {
        actions.push(input)
        return { started: true, reason: null }
      },
      'terminal.open': (input) => {
        opens.push(input)
        return { started: true, reason: null }
      }
    }
  })
}

/** A line is open when its actions are drawn. */
const isOpen = (v: TestPanel, id: string) => v.find({ testId: `up:${id}` }) !== null
/** The words of a line: its title, dots and note. */
const lineOf = (v: TestPanel, id: string) => v.find({ testId: `line:${id}` })?.text ?? null
/** The ids of the lines drawn, in order: workspace ids, `shared:<repo key>` and `stopped`. */
const drawn = (v: TestPanel) => {
  const keys: string[] = []
  const walk = (n: TreeSnapshot | string | null | undefined) => {
    if (n === null || n === undefined || typeof n === 'string') return
    if (n.type === 'Row' && n.key?.startsWith('line:')) keys.push(n.key.slice('line:'.length))
    for (const c of n.children ?? []) walk(c)
  }
  walk(v.tree())
  return keys
}
const withRow = (v: StackView, id: string, change: Partial<RowView>): StackView => ({
  ...v,
  repos: v.repos.map((r) => ({ ...r, rows: r.rows.map((x) => (x.workspace.id === id ? { ...x, ...change } : x)) }))
})

test('focused running: repo · branch first, always open, its services and the shared ones', async () => {
  view = await mount(panel, { host: host(base) })
  assert.match(lineOf(view, MAIN) ?? '', /^devtrees-fixture · main/)
  assert.equal(isOpen(view, MAIN), true)
  // No chevron: the focused worktree cannot be closed.
  assert.equal(view.find({ testId: `row:${MAIN}` }), null)
  assert.ok(view.find({ testId: `service:${MAIN}:web` }))
  assert.ok(view.find({ text: ':41230' }))
  // The repo's shared cache, tagged, with its own logs.
  const cache = view.find({ testId: `service:shared:${FIXTURE}:cache` })
  assert.match(cache?.text ?? '', /cache.*:50000.*shared/)
  assert.ok(view.find({ testId: `logs:shared:${FIXTURE}:cache` }))
  assert.equal(view.find({ label: 'Restart cache' }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('below: a flat list of running stacks, repo first, then the running shared instances', async () => {
  view = await mount(panel, { host: host(base) })
  // The focused repo's shared instance is not repeated; stopped rows fold into one line.
  assert.deepEqual(drawn(view), [MAIN, FEAT, FIX, `shared:${DEMO}`, 'stopped'])
  assert.match(lineOf(view, FEAT) ?? '', /^● demo-app · feat\/x ● ●$/)
  assert.match(lineOf(view, `shared:${DEMO}`) ?? '', /demo-app · shared/)
  assert.equal(view.find({ text: 'devtrees-fixture' }), null)
  assert.equal(isOpen(view, FEAT), false)
  await view.press({ testId: `row:${FEAT}` })
  assert.equal(isOpen(view, FEAT), true)
  assert.ok(view.find({ testId: `service:${FEAT}:web` }))
  // The list's lines show only their own services; the shared instance has its own line.
  assert.equal(view.find({ testId: `service:shared:${DEMO}:db` }), null)
  await view.press({ testId: `row:shared:${DEMO}` })
  assert.ok(view.find({ testId: `service:shared:${DEMO}:db` }))
})

test('focused down: services greyed from a sibling, only Up left to press', async () => {
  view = await mount(panel, { host: host({ ...base, focusedId: IDLE }) })
  assert.equal(drawn(view)[0], IDLE)
  assert.equal(view.find({ testId: `up:${IDLE}` })?.disabled, false)
  for (const id of [`down:${IDLE}`, `restart:${IDLE}`, `logs:${IDLE}`, `attach:${IDLE}`]) assert.equal(view.find({ testId: id })?.disabled, true)
  // web and worker come from main, which runs; they are stopped here and have no ports.
  const web = view.find({ testId: `service:${IDLE}:web` })
  assert.ok(web)
  assert.equal(/:41230/.test(web?.text ?? ''), false)
  assert.equal(view.find({ testId: `logs:${IDLE}:web` })?.disabled, true)
  // The shared cache runs, whatever this worktree does.
  assert.equal(view.find({ testId: `logs:shared:${FIXTURE}:cache` })?.disabled, false)
  // main runs, so it is listed below.
  assert.ok(drawn(view).includes(MAIN))
})

test('no focus: no focused section, only the list and the stopped line', async () => {
  view = await mount(panel, { host: host({ ...base, focusedId: null }) })
  assert.deepEqual(drawn(view), [MAIN, `shared:${FIXTURE}`, FEAT, FIX, `shared:${DEMO}`, 'stopped'])
  for (const id of [MAIN, FEAT, FIX]) assert.equal(isOpen(view, id), false)
  assert.equal(view.find({ type: 'Separator' }), null)
  await view.post('stack.changed', { ...base, focusedId: MAIN, focusUnknown: true })
  assert.equal(isOpen(view, MAIN), false)
  assert.ok(view.find({ text: /orca CLI could not be run/ }))
})

test('stopped worktrees fold into one muted line that opens to list them, each with Up', async () => {
  view = await mount(panel, { host: host(base) })
  assert.match(lineOf(view, 'stopped') ?? '', /^2 stopped$/)
  assert.equal(drawn(view).includes(IDLE), false)
  await view.press({ testId: 'row:stopped' })
  assert.deepEqual(drawn(view).slice(-3), ['stopped', IDLE, OLD])
  // A stopped line: a hollow dot, no service dots.
  assert.match(lineOf(view, IDLE) ?? '', /^○ devtrees-fixture · idle$/)
  await view.press({ testId: `row:${IDLE}` })
  assert.equal(view.find({ testId: `up:${IDLE}` })?.disabled, false)
  assert.equal(view.find({ testId: `down:${IDLE}` })?.disabled, true)
})

test('only stopped others: the focused worktree and one stopped line', async () => {
  view = await mount(panel, { host: host({ ...base, repos: [{ ...fixture, shared: null }, { ...demo, shared: null, rows: [demo.rows[2]] }] }) })
  assert.deepEqual(drawn(view), [MAIN, 'stopped'])
  assert.match(lineOf(view, 'stopped') ?? '', /^2 stopped$/)
})

test('each line sends its own workspace id, whatever is focused', async () => {
  const actions: unknown[] = []
  view = await mount(panel, { host: host(base, actions) })
  await view.press({ testId: `row:${FEAT}` })
  await view.press({ testId: `up:${FEAT}` })
  await view.press({ testId: `restart:${FEAT}` })
  await view.press({ testId: `restart:${FEAT}:web` })
  await view.press({ testId: `down:${MAIN}` })
  assert.deepEqual(actions, [
    { workspaceId: FEAT, action: 'up' },
    { workspaceId: FEAT, action: 'restart' },
    { workspaceId: FEAT, action: 'restart-service', service: 'web' },
    { workspaceId: MAIN, action: 'down' }
  ])
})

test('Logs and Attach: per stack, per service, and for the shared instance', async () => {
  const opens: unknown[] = []
  view = await mount(panel, { host: host(base, [], opens) })
  await view.press({ testId: `attach:${MAIN}` })
  await view.press({ testId: `logs:${MAIN}` })
  await view.press({ testId: `logs:${MAIN}:web` })
  await view.press({ testId: `attach:${MAIN}:web` })
  await view.press({ testId: `logs:shared:${FIXTURE}:cache` })
  await view.press({ testId: `attach:shared:${FIXTURE}:cache` })
  await view.press({ testId: `row:shared:${DEMO}` })
  await view.press({ testId: `attach:shared:${DEMO}` })
  await view.press({ testId: `logs:shared:${DEMO}:db` })
  assert.deepEqual(opens, [
    { workspaceId: MAIN, what: 'attach' },
    { workspaceId: MAIN, what: 'logs' },
    { workspaceId: MAIN, what: 'logs', service: 'web', shared: false },
    { workspaceId: MAIN, what: 'attach', shared: false },
    { workspaceId: MAIN, what: 'logs', service: 'cache', shared: true },
    { workspaceId: MAIN, what: 'attach', shared: true },
    { workspaceId: FEAT, what: 'attach', shared: true },
    { workspaceId: FEAT, what: 'logs', service: 'db', shared: true }
  ])
})

test('busy state is per line, and a busy stopped worktree is listed, not folded', async () => {
  view = await mount(panel, { host: host(base) })
  await view.post('stack.changed', withRow(base, MAIN, { busy: { action: 'up', service: null, since: 0 } }))
  assert.ok(view.find({ text: /Starting/ }))
  assert.equal(view.find({ testId: `up:${MAIN}` })?.disabled, true)
  assert.match(lineOf(view, MAIN) ?? '', /starting/)
  await view.post('stack.changed', withRow(base, OLD, { busy: { action: 'up', service: null, since: 0 } }))
  assert.deepEqual(drawn(view), [MAIN, FEAT, FIX, OLD, `shared:${DEMO}`, 'stopped'])
  assert.match(lineOf(view, 'stopped') ?? '', /^1 stopped$/)
})

test('lines stay as the person left them across posts', async () => {
  view = await mount(panel, { host: host(base) })
  await view.press({ testId: `row:${FEAT}` })
  await view.press({ testId: 'row:stopped' })
  await view.post('stack.changed', { ...base, focusedId: FIX })
  assert.equal(isOpen(view, FEAT), true)
  assert.equal(isOpen(view, FIX), true)
  // main is no longer focused, so it is listed.
  assert.deepEqual(drawn(view).slice(0, 3), [FIX, MAIN, `shared:${FIXTURE}`])
  assert.ok(drawn(view).includes(IDLE))
})

test('a failed action shows on its line', async () => {
  view = await mount(panel, { host: host(base) })
  await view.post('stack.changed', withRow(base, FEAT, {
    lastError: { action: 'up', code: 'HEALTH_TIMEOUT', message: 'web did not become healthy', at: 0 }
  }))
  assert.match(lineOf(view, FEAT) ?? '', /up failed/)
  await view.press({ testId: `row:${FEAT}` })
  assert.match(view.summary().join('\n'), /HEALTH_TIMEOUT/)
})

test('empty, missing and error states', async () => {
  view = await mount(panel, { host: host({ ...base, repos: [] }) })
  assert.match(view.summary().join('\n'), /No devtrees worktrees/)
  await view.post('stack.changed', { ...base, kind: 'too-old' })
  assert.match(view.summary().join('\n'), /too old/)
  await view.post('stack.changed', { ...base, kind: 'not-installed' })
  assert.match(view.summary().join('\n'), /devtrees not found/)
  await view.post('stack.changed', {
    ...base,
    repos: [fixture, { ...demo, kind: 'error', message: 'CONFIG_INVALID: bad', shared: null, rows: demo.rows.map((r) => ({ ...r, stack: null })) }]
  })
  assert.ok(view.find({ text: 'demo-app: devtrees failed: CONFIG_INVALID: bad' }))
  // Unreadable stacks are listed, not folded, with a note.
  assert.match(lineOf(view, FEAT) ?? '', /unreadable/)
  assert.match(lineOf(view, 'stopped') ?? '', /^1 stopped$/)
})

test('the worker not answering', async () => {
  view = await mount(panel, {
    host: mockHost({
      requests: {
        'stack.get': () => {
          throw new Error('worker gone')
        }
      }
    })
  })
  assert.match(view.summary().join('\n'), /No answer from the worker/)
})

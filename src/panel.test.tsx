// The panel over a stand-in worker: what each plugin.request answers.
import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panel from './panel'
import type { InstanceView, RowView, StackView } from './protocol'

const MAIN = 'identity:wt2:local:1'
const FEATURE = 'identity:wt2:local:2'
const OTHER = 'identity:wt2:local:3'
const IDLE = 'identity:wt2:local:4'

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
const shared: InstanceView = {
  status: 'up',
  id: 'shared',
  namespaces: ['default'],
  services: [
    {
      name: 'db',
      status: 'Running',
      state: 'active',
      health: 'unknown',
      tier: 'shared',
      ports: [
        { name: 'APP_SHARED_DB_PORT', port: 50000 },
        { name: 'APP_SHARED_DB_SHADOW_PORT', port: 50001 }
      ]
    }
  ]
}
const rowOf = (id: string, name: string, path: string, stack: InstanceView, branch = name): RowView => ({
  workspace: { id, name, path, branch, project: null },
  stack,
  busy: null,
  lastError: null
})

// Two repos, each with a "main"; feature-x is focused and stopped; idle is stopped.
const base: StackView = {
  kind: 'ok',
  repos: [
    {
      key: '/w/app/.git',
      label: 'app',
      kind: 'ok',
      message: null,
      shared,
      rows: [
        rowOf(MAIN, 'main', '/w/app', running('main-11111111', 41230)),
        rowOf(IDLE, 'idle', '/w/wt/idle', down('idle-44444444')),
        rowOf(FEATURE, 'feature-x', '/w/wt/feature-x', down('feature-x-22222222'), 'feat/x')
      ]
    },
    { key: '/w/other/.git', label: 'other', kind: 'ok', message: null, shared: null, rows: [rowOf(OTHER, 'main', '/w/other', running('main-33333333', 41330))] }
  ],
  focusedId: FEATURE,
  focusUnknown: false,
  executable: 'devtrees'
}

let view: TestPanel | undefined
afterEach(async () => {
  await view?.unmount()
  view = undefined
})

function host(answer: StackView, actions: unknown[] = []) {
  return mockHost({
    requests: {
      'stack.get': () => answer,
      'stack.action': (input) => {
        actions.push(input)
        return { started: true, reason: null }
      }
    }
  })
}

/** A row is open when its actions are drawn. */
const isOpen = (v: TestPanel, id: string) => v.find({ testId: `up:${id}` }) !== null
/** The words of a row's one line: its name, branch and note. */
const lineOf = (v: TestPanel, id: string) => v.find({ testId: `line:${id}` })?.text ?? null
/** Workspace ids of the rows drawn, in order. */
const drawn = (v: TestPanel) =>
  v
    .findAll({ type: 'Row' })
    .map((e) => e.key)
    .filter((k): k is string => k?.startsWith('line:') ?? false)
    .map((k) => k.slice('line:'.length))
const withRow = (v: StackView, id: string, change: Partial<RowView>): StackView => ({
  ...v,
  repos: v.repos.map((r) => ({ ...r, rows: r.rows.map((x) => (x.workspace.id === id ? { ...x, ...change } : x)) }))
})

test('groups rows by repo, focused and running first, other stopped rows folded', async () => {
  view = await mount(panel, { host: host(base) })
  assert.ok(view.find({ text: 'app' }))
  assert.ok(view.find({ text: 'other' }))
  // feature-x is stopped but focused: shown first and open. idle is folded away.
  assert.deepEqual(drawn(view), [FEATURE, MAIN, OTHER])
  assert.equal(isOpen(view, FEATURE), true)
  assert.equal(isOpen(view, MAIN), false)
  assert.ok(view.find({ type: 'Collapsible', label: '1 stopped' }) ?? view.find({ text: /1 stopped/ }))
  await view.toggle({ testId: 'stopped:/w/app/.git' })
  assert.deepEqual(drawn(view), [FEATURE, MAIN, IDLE, OTHER])
  assert.match(String(view.find({ testId: 'stopped:/w/app/.git' })?.props?.title), /^1 stopped$/)
  assert.ok(view.find({ text: '2 running · 2 stopped' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('a row is one line: the name, the branch only when it differs, and a short note', async () => {
  view = await mount(panel, { host: host(base) })
  assert.match(lineOf(view, FEATURE) ?? '', /feature-x.*feat\/x/)
  assert.equal(/main.*main/.test(lineOf(view, MAIN) ?? ''), false)
  const degraded = withRow(base, MAIN, { stack: { ...running('main-11111111', 41230), status: 'partial' } })
  await view.post('stack.changed', degraded)
  assert.match(lineOf(view, MAIN) ?? '', /1 dead/)
})

test('an open row shows services with short port links; shared services have no restart', async () => {
  view = await mount(panel, { host: host(base) })
  await view.press({ testId: `row:${MAIN}` })
  assert.equal(isOpen(view, MAIN), true)
  assert.ok(view.find({ text: ':41230' }))
  assert.ok(view.find({ testId: `restart:${MAIN}:web` }))
  // The shared section is one closed line until opened.
  const sharedLine = view.find({ testId: 'shared:/w/app/.git' })
  assert.equal(sharedLine?.props?.title, 'Shared · 1 running')
  assert.equal(view.find({ testId: 'shared:/w/other/.git' })?.props?.title, 'Shared · down')
  await view.toggle({ testId: 'shared:/w/app/.git' })
  assert.ok(view.find({ text: 'db' }))
  assert.match(view.find({ text: /db shadow/ })?.text ?? '', /db :50000 · db shadow :50001/)
  assert.equal(view.find({ label: 'Restart db' }), null)
})

test('each row sends its own workspace id, whatever is focused', async () => {
  const actions: unknown[] = []
  view = await mount(panel, { host: host(base, actions) })
  await view.press({ testId: `row:${OTHER}` })
  await view.press({ testId: `up:${OTHER}` })
  await view.press({ testId: `restart:${OTHER}` })
  await view.press({ testId: `restart:${OTHER}:web` })
  await view.press({ testId: `up:${FEATURE}` })
  assert.deepEqual(actions, [
    { workspaceId: OTHER, action: 'up' },
    { workspaceId: OTHER, action: 'restart' },
    { workspaceId: OTHER, action: 'restart-service', service: 'web' },
    { workspaceId: FEATURE, action: 'up' }
  ])
})

test('Attach and Logs send the pressed row, and the shared section its repo', async () => {
  const opens: unknown[] = []
  view = await mount(panel, {
    host: mockHost({
      requests: {
        'stack.get': () => base,
        'terminal.open': (input) => {
          opens.push(input)
          return { started: true, reason: null }
        }
      }
    })
  })
  await view.press({ testId: `row:${OTHER}` })
  await view.press({ testId: `attach:${OTHER}` })
  await view.press({ testId: `logs:${OTHER}` })
  await view.press({ testId: `logs:${OTHER}:web` })
  await view.toggle({ testId: 'shared:/w/app/.git' })
  await view.press({ testId: 'attach:shared:/w/app/.git' })
  await view.press({ testId: 'logs:shared:/w/app/.git:db' })
  assert.deepEqual(opens, [
    { workspaceId: OTHER, what: 'attach' },
    { workspaceId: OTHER, what: 'logs' },
    { workspaceId: OTHER, what: 'logs', service: 'web', shared: false },
    { workspaceId: MAIN, what: 'attach', shared: true },
    { workspaceId: MAIN, what: 'logs', service: 'db', shared: true }
  ])
  // A stopped stack has nothing to attach to.
  assert.equal(view.find({ testId: `attach:${FEATURE}` })?.disabled, true)
})

test('without a resolved focus, nothing is opened and stopped rows fold', async () => {
  view = await mount(panel, { host: host({ ...base, focusedId: null }) })
  for (const id of [MAIN, OTHER]) assert.equal(isOpen(view, id), false)
  assert.deepEqual(drawn(view), [MAIN, OTHER])
  assert.equal(view.find({ testId: 'stopped:/w/app/.git' })?.props?.title, '2 stopped')
  // Every row still has its actions.
  await view.press({ testId: `row:${MAIN}` })
  assert.equal(view.find({ testId: `up:${MAIN}` })?.disabled, false)
})

test('busy state is per row, and a busy row is never folded', async () => {
  view = await mount(panel, { host: host(base) })
  await view.press({ testId: `row:${MAIN}` })
  await view.post('stack.changed', withRow(base, MAIN, { busy: { action: 'up', service: null, since: 0 } }))
  assert.ok(view.find({ text: /Starting/ }))
  assert.equal(view.find({ testId: `up:${MAIN}` })?.disabled, true)
  assert.equal(view.find({ testId: `up:${FEATURE}` })?.disabled, false)
  assert.match(lineOf(view, MAIN) ?? '', /starting/)
  await view.post('stack.changed', withRow(base, IDLE, { busy: { action: 'up', service: null, since: 0 } }))
  assert.deepEqual(drawn(view), [FEATURE, MAIN, IDLE, OTHER])
})

test('rows and sections stay as the person left them across posts', async () => {
  view = await mount(panel, { host: host(base) })
  await view.press({ testId: `row:${FEATURE}` })
  await view.press({ testId: `row:${OTHER}` })
  await view.toggle({ testId: 'stopped:/w/app/.git' })
  await view.post('stack.changed', { ...base, focusedId: OTHER })
  assert.equal(isOpen(view, FEATURE), false)
  assert.equal(isOpen(view, OTHER), true)
  // feature-x is no longer focused, so it folds; the fold is still open.
  assert.equal(view.find({ testId: 'stopped:/w/app/.git' })?.props?.open, true)
  assert.deepEqual(drawn(view), [MAIN, IDLE, FEATURE, OTHER])
})

test('a failed action shows on its row', async () => {
  view = await mount(panel, { host: host(base) })
  await view.post('stack.changed', withRow(base, FEATURE, {
    lastError: { action: 'up', code: 'HEALTH_TIMEOUT', message: 'web did not become healthy', at: 0 }
  }))
  assert.match(view.summary().join('\n'), /HEALTH_TIMEOUT/)
  assert.match(lineOf(view, FEATURE) ?? '', /up failed/)
})

test('empty and error states', async () => {
  view = await mount(panel, { host: host({ ...base, repos: [] }) })
  assert.match(view.summary().join('\n'), /No devtrees worktrees/)
  await view.post('stack.changed', { ...base, kind: 'too-old' })
  assert.match(view.summary().join('\n'), /too old/)
  await view.post('stack.changed', { ...base, kind: 'not-installed' })
  assert.match(view.summary().join('\n'), /devtrees not found/)
  await view.post('stack.changed', {
    ...base,
    repos: [{ ...base.repos[1], kind: 'error', message: 'CONFIG_INVALID: bad', shared: null, rows: base.repos[1].rows.map((r) => ({ ...r, stack: null })) }]
  })
  assert.ok(view.find({ text: /devtrees failed: CONFIG_INVALID/ }))
  assert.match(lineOf(view, OTHER) ?? '', /unreadable/)
  await view.post('stack.changed', { ...base, focusedId: null, focusUnknown: true })
  assert.ok(view.find({ text: /orca CLI could not be run/ }))
})

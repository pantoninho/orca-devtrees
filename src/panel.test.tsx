// The panel over a stand-in worker: what each plugin.request answers.
import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panel from './panel'
import type { InstanceView, RowView, StackView } from './protocol'

const MAIN = 'identity:wt2:local:1'
const FEATURE = 'identity:wt2:local:2'
const OTHER = 'identity:wt2:local:3'

const running = (id: string, port: number): InstanceView => ({
  status: 'up',
  id,
  namespaces: ['default'],
  services: [
    { name: 'web', status: 'Running', state: 'active', health: 'ready', tier: 'isolated', ports: [{ name: 'WEB_PORT', port }] },
    { name: 'worker', status: 'Completed', state: 'dead', health: 'unknown', tier: 'isolated', ports: [] }
  ]
})
const shared: InstanceView = {
  status: 'up',
  id: 'shared',
  namespaces: ['default'],
  services: [{ name: 'db', status: 'Running', state: 'active', health: 'unknown', tier: 'shared', ports: [{ name: 'DB_PORT', port: 50000 }] }]
}
const rowOf = (id: string, name: string, path: string, stack: InstanceView): RowView => ({
  workspace: { id, name, path, branch: name, project: null },
  stack,
  busy: null,
  lastError: null
})

// Two repos, each with a "main"; feature-x is focused.
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
        rowOf(FEATURE, 'feature-x', '/w/wt/feature-x', { status: 'down', id: 'feature-x-22222222', namespaces: [], services: [] })
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

const isOpen = (v: TestPanel, id: string) => v.find({ testId: `row:${id}` })?.props?.open
const withRow = (v: StackView, id: string, change: Partial<RowView>): StackView => ({
  ...v,
  repos: v.repos.map((r) => ({ ...r, rows: r.rows.map((x) => (x.workspace.id === id ? { ...x, ...change } : x)) }))
})

test('lists every row grouped by repo, with the focused one open', async () => {
  view = await mount(panel, { host: host(base) })
  const text = view.summary().join('\n')
  assert.match(text, /Heading "app"/)
  assert.match(text, /Heading "other"/)
  const titles = view.findAll({ type: 'Collapsible' }).map((e) => e.props.title)
  assert.deepEqual(titles, ['main', 'feature-x', 'main'])
  assert.equal(isOpen(view, FEATURE), true)
  assert.equal(isOpen(view, MAIN), false)
  assert.equal(isOpen(view, OTHER), false)
  assert.match(String(view.find({ testId: `row:${FEATURE}` })?.props?.description), /down · focused/)
  assert.equal(view.find({ testId: `row:${MAIN}` })?.props?.description, 'up')
  const degraded = withRow(base, MAIN, { stack: { ...running('main-11111111', 41230), status: 'partial' } })
  await view.post('stack.changed', degraded)
  assert.equal(view.find({ testId: `row:${MAIN}` })?.props?.description, '1 dead')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('an open row shows services, tiers and port links; shared services have no restart', async () => {
  view = await mount(panel, { host: host(base) })
  await view.toggle({ testId: `row:${MAIN}` })
  assert.equal(isOpen(view, MAIN), true)
  assert.ok(view.find({ text: 'localhost:41230' }))
  assert.ok(view.find({ text: 'db' }))
  assert.ok(view.find({ testId: `restart:${MAIN}:web` }))
  assert.equal(view.find({ label: 'Restart db' }), null)
})

test('each row sends its own workspace id, whatever is focused', async () => {
  const actions: unknown[] = []
  view = await mount(panel, { host: host(base, actions) })
  await view.toggle({ testId: `row:${OTHER}` })
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
  await view.toggle({ testId: `row:${OTHER}` })
  await view.press({ testId: `attach:${OTHER}` })
  await view.press({ testId: `logs:${OTHER}` })
  await view.press({ testId: `logs:${OTHER}:web` })
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

test('without a resolved focus, nothing is highlighted or opened', async () => {
  view = await mount(panel, { host: host({ ...base, focusedId: null }) })
  for (const id of [MAIN, FEATURE, OTHER]) assert.equal(isOpen(view, id), false)
  assert.equal(view.find({ testId: `row:${FEATURE}` })?.props?.description, 'down')
  // Every row still has its actions.
  await view.toggle({ testId: `row:${MAIN}` })
  assert.equal(view.find({ testId: `up:${MAIN}` })?.disabled, false)
})

test('busy state is per row', async () => {
  view = await mount(panel, { host: host(base) })
  await view.toggle({ testId: `row:${MAIN}` })
  await view.post('stack.changed', withRow(base, MAIN, { busy: { action: 'up', service: null, since: 0 } }))
  assert.ok(view.find({ text: /Starting/ }))
  assert.equal(view.find({ testId: `up:${MAIN}` })?.disabled, true)
  assert.equal(view.find({ testId: `up:${FEATURE}` })?.disabled, false)
  assert.match(String(view.find({ testId: `row:${MAIN}` })?.props?.description), /starting/)
})

test('a row stays as the person left it across posts', async () => {
  view = await mount(panel, { host: host(base) })
  await view.toggle({ testId: `row:${FEATURE}` })
  await view.toggle({ testId: `row:${OTHER}` })
  await view.post('stack.changed', { ...base, focusedId: OTHER })
  assert.equal(isOpen(view, FEATURE), false)
  assert.equal(isOpen(view, OTHER), true)
})

test('a failed action shows on its row', async () => {
  view = await mount(panel, { host: host(base) })
  await view.post('stack.changed', withRow(base, FEATURE, {
    lastError: { action: 'up', code: 'HEALTH_TIMEOUT', message: 'web did not become healthy', at: 0 }
  }))
  assert.match(view.summary().join('\n'), /HEALTH_TIMEOUT/)
  assert.match(String(view.find({ testId: `row:${FEATURE}` })?.props?.description), /up failed/)
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
  assert.match(view.summary().join('\n'), /devtrees failed/)
  await view.post('stack.changed', { ...base, focusedId: null, focusUnknown: true })
  assert.ok(view.find({ text: /orca CLI could not be run/ }))
})

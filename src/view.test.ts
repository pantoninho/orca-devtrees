import { assert, test } from 'orca/testing'
import type { InstanceView, RepoView, RowView, ServiceView, StackView } from './protocol'
import { layoutOf, portLabels, rowDot, serviceDot, serviceLines } from './view'

const labels = (...names: string[]) => portLabels(names.map((name, i) => ({ name, port: 1000 + i }))).map((p) => p.label)

test('shortens port labels: no _PORT, no shared prefix, lowercase', () => {
  assert.deepEqual(labels('WEB_PORT'), ['web'])
  assert.deepEqual(labels('API_HTTP_PORT', 'API_DEBUG_PORT'), ['http', 'debug'])
  assert.deepEqual(labels('SUPABASE_SHARED_API_PORT', 'SUPABASE_SHARED_DB_SHADOW_PORT'), ['api', 'db shadow'])
  // Each label keeps at least one word.
  assert.deepEqual(labels('APP_DB_PORT', 'APP_DB_SHADOW_PORT'), ['db', 'db shadow'])
  assert.deepEqual(labels('PORT'), ['port'])
  assert.deepEqual(labels('CACHE'), ['cache'])
  assert.deepEqual(portLabels([{ name: 'WEB_PORT', port: 5 }]), [{ name: 'WEB_PORT', label: 'web', port: 5 }])
})

const service = (state: ServiceView['state'], health: ServiceView['health']): ServiceView => ({
  name: 'web',
  status: 'Running',
  state,
  health,
  tier: 'isolated',
  ports: []
})

test('one dot per service: green running, amber not ready or in transition, red dead, grey done', () => {
  assert.equal(serviceDot(service('active', 'ready')), 'success')
  // No readiness probe is the usual case: running is enough.
  assert.equal(serviceDot(service('active', 'unknown')), 'success')
  for (const status of ['Pending', 'Launching', 'Restarting', 'Terminating']) {
    assert.equal(serviceDot({ ...service('active', 'unknown'), status }), 'warning')
  }
  assert.equal(serviceDot(service('active', 'not_ready')), 'warning')
  assert.equal(serviceDot(service('dead', 'unknown')), 'danger')
  assert.equal(serviceDot(service('done', 'unknown')), 'neutral')
})

const named = (name: string, tier: ServiceView['tier'] = 'isolated'): ServiceView => ({
  ...service('active', 'ready'),
  name,
  tier,
  ports: [{ name: 'X_PORT', port: 1 }]
})
const instance = (status: InstanceView['status'], services: ServiceView[] = []): InstanceView => ({ status, id: 'i', namespaces: [], services })
const row = (id: string, stack: InstanceView | null, change: Partial<RowView> = {}): RowView => ({
  workspace: { id, name: id, path: `/w/${id}`, branch: id, project: null },
  stack,
  busy: null,
  lastError: null,
  ...change
})
const repo = (key: string, rows: RowView[], shared: InstanceView | null = null): RepoView => ({ key, label: key, kind: 'ok', message: null, rows, shared })
const stackView = (repos: RepoView[], focusedId: string | null): StackView => ({ kind: 'ok', repos, focusedId, focusUnknown: false, executable: 'devtrees' })

test('layout: focused apart, running listed with running shared instances, idle stopped folded', () => {
  const a = repo('a', [row('a1', instance('up')), row('a2', instance('down')), row('a3', instance('down'), { busy: { action: 'up', service: null, since: 0 } })], instance('up'))
  const b = repo('b', [row('b1', instance('down')), row('b2', null)], instance('up'))
  const c = repo('c', [row('c1', instance('up'))], instance('down'))
  const ids = (l: ReturnType<typeof layoutOf>) => l.running.map((e) => (e.kind === 'row' ? e.row.workspace.id : `shared:${e.repo.key}`))
  const focused = layoutOf(stackView([a, b, c], 'b1'))
  assert.equal(focused.focused?.row.workspace.id, 'b1')
  // b's shared instance is shown in the focused worktree, not listed.
  assert.deepEqual(ids(focused), ['a1', 'a3', 'shared:a', 'b2', 'c1'])
  assert.deepEqual(focused.stopped.map((p) => p.row.workspace.id), ['a2'])
  const none = layoutOf(stackView([a, b, c], null))
  assert.equal(none.focused, null)
  assert.deepEqual(ids(none), ['a1', 'a3', 'shared:a', 'b2', 'shared:b', 'c1'])
  assert.deepEqual(none.stopped.map((p) => p.row.workspace.id), ['a2', 'b1'])
  // Focus unknown counts as none.
  assert.equal(layoutOf({ ...stackView([a], 'a1'), focusUnknown: true }).focused, null)
  assert.equal(rowDot(row('x', null)), 'danger')
  assert.equal(rowDot(a.rows[2]), 'warning')
})

test('service lines: own isolated ones, then shared from the running shared instance', () => {
  const up = row('up', instance('up', [named('web'), named('cache', 'shared')]))
  const shared = instance('up', [{ ...named('cache', 'shared'), ports: [{ name: 'CACHE_PORT', port: 50000 }] }])
  const r = repo('r', [up], shared)
  const lines = serviceLines(r, up, true)
  assert.deepEqual(lines.map((l) => [l.service.name, l.shared, l.placeholder]), [['web', false, false], ['cache', true, false]])
  assert.equal(lines[1].service.ports[0].port, 50000)
  assert.deepEqual(serviceLines(r, up, false).map((l) => l.service.name), ['web'])
  // Without a running shared instance, the worktree's own listing of its shared services.
  assert.deepEqual(serviceLines(repo('r', [up]), up, true).map((l) => [l.service.name, l.shared]), [['web', false], ['cache', true]])
})

test('a stopped stack borrows its service names, greyed and without ports, from a sibling', () => {
  const up = row('up', instance('up', [named('web'), named('cache', 'shared')]))
  const idle = row('idle', instance('down'))
  const lines = serviceLines(repo('r', [idle, up]), idle, true)
  assert.deepEqual(lines.map((l) => [l.service.name, l.shared, l.placeholder, l.service.ports.length]), [
    ['web', false, true, 0],
    ['cache', true, true, 0]
  ])
  assert.equal(serviceDot(lines[0].service), 'neutral')
  // The shared instance still runs: its services are real.
  const withShared = serviceLines(repo('r', [idle, up], instance('up', [named('cache', 'shared')])), idle, true)
  assert.deepEqual(withShared.map((l) => l.placeholder), [true, false])
  // No sibling lists any: nothing to show.
  assert.deepEqual(serviceLines(repo('r', [idle]), idle, true), [])
})


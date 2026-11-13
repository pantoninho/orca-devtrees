import { assert, test } from 'orca/testing'
import type { RowView, ServiceView } from './protocol'
import { portLabels, rowDot, serviceDot, splitRows } from './view'

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

test('one dot per service: green healthy, amber starting or unknown, red dead, grey done', () => {
  assert.equal(serviceDot(service('active', 'ready')), 'success')
  assert.equal(serviceDot(service('active', 'unknown')), 'warning')
  assert.equal(serviceDot(service('active', 'not_ready')), 'warning')
  assert.equal(serviceDot(service('dead', 'unknown')), 'danger')
  assert.equal(serviceDot(service('done', 'unknown')), 'neutral')
})

const row = (id: string, status: 'up' | 'down', change: Partial<RowView> = {}): RowView => ({
  workspace: { id, name: id, path: `/w/${id}`, branch: id, project: null },
  stack: { status, id, namespaces: [], services: [] },
  busy: null,
  lastError: null,
  ...change
})

test('rows: running and focused first, idle stopped ones folded', () => {
  const rows = [row('a', 'down'), row('b', 'up'), row('c', 'down'), row('d', 'down', { busy: { action: 'up', service: null, since: 0 } })]
  const { shown, folded } = splitRows(rows, 'c')
  assert.deepEqual(shown.map((r) => r.workspace.id), ['c', 'b', 'd'])
  assert.deepEqual(folded.map((r) => r.workspace.id), ['a'])
  assert.equal(rowDot(rows[0]), 'neutral')
  assert.equal(rowDot(rows[1]), 'success')
  assert.equal(rowDot(rows[3]), 'warning')
  assert.equal(rowDot(row('e', 'up', { stack: null })), 'danger')
})

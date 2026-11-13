// The panel over a stand-in worker: what each plugin.request answers.
import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panel from './panel'
import type { StackView } from './protocol'

const base: StackView = {
  kind: 'ok',
  workspace: { id: 'identity:wt2:local:2', name: 'feature-x', path: '/w/feature-x', branch: 'feature-x', project: null },
  resolvedBy: 'terminals',
  candidates: [],
  message: null,
  stack: {
    status: 'up',
    id: 'feature-x-12345678',
    namespaces: ['default'],
    services: [
      { name: 'web', status: 'Running', state: 'active', health: 'ready', tier: 'isolated', ports: [{ name: 'WEB_PORT', port: 41230 }] },
      { name: 'worker', status: 'Completed', state: 'dead', health: 'unknown', tier: 'isolated', ports: [] }
    ]
  },
  shared: {
    status: 'up',
    id: 'shared',
    namespaces: ['default'],
    services: [{ name: 'db', status: 'Running', state: 'active', health: 'unknown', tier: 'shared', ports: [{ name: 'DB_PORT', port: 50000 }] }]
  },
  busy: null,
  lastError: null,
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

test('lists services with their state, tier and port links', async () => {
  view = await mount(panel, { host: host(base) })
  assert.ok(view.find({ text: 'web' }))
  assert.ok(view.find({ text: 'localhost:41230' }))
  assert.ok(view.find({ text: 'db' }))
  assert.ok(view.find({ text: 'dead' }))
  assert.ok(view.find({ label: 'Restart web' }))
  // Shared services are never restarted from a worktree.
  assert.equal(view.find({ label: 'Restart db' }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('Up, Restart and per-service restart ask the worker', async () => {
  const actions: unknown[] = []
  view = await mount(panel, { host: host(base, actions) })
  await view.press({ text: 'Up' })
  await view.press({ text: 'Restart' })
  await view.press({ label: 'Restart web' })
  assert.deepEqual(actions, [{ action: 'up' }, { action: 'restart' }, { action: 'restart-service', service: 'web' }])
})

test('follows what the worker posts', async () => {
  view = await mount(panel, { host: host(base) })
  await view.post('stack.changed', { ...base, busy: { action: 'up', service: null, since: 0 } })
  assert.ok(view.find({ text: /Starting/ }))
  assert.equal(view.find({ role: 'button', text: 'Up' })?.props?.disabled, true)
  await view.post('stack.changed', {
    ...base,
    lastError: { action: 'up', code: 'HEALTH_TIMEOUT', message: 'web did not become healthy', at: 0 }
  })
  assert.match(view.summary().join('\n'), /HEALTH_TIMEOUT/)
})

test('empty states', async () => {
  view = await mount(panel, { host: host({ ...base, kind: 'no-config', stack: null, shared: null }) })
  assert.match(view.summary().join('\n'), /No devtrees\.yaml/)
  await view.post('stack.changed', { ...base, kind: 'too-old', stack: null, shared: null })
  assert.match(view.summary().join('\n'), /too old/)
  await view.post('stack.changed', { ...base, kind: 'not-installed', stack: null, shared: null })
  assert.match(view.summary().join('\n'), /devtrees not found/)
  await view.post('stack.changed', { ...base, kind: 'no-workspace', workspace: null, stack: null, shared: null })
  assert.match(view.summary().join('\n'), /No worktree focused/)
})

test('an unresolved worktree shows the picker and no actions', async () => {
  const candidates: StackView['candidates'] = [
    { id: 'a', name: 'main', path: '/w/app/main', branch: 'main', project: 'app' },
    { id: 'b', name: 'main', path: '/w/other/main', branch: 'main', project: null }
  ]
  const picks: unknown[] = []
  const unresolved: StackView = {
    ...base,
    kind: 'unresolved',
    workspace: null,
    resolvedBy: null,
    candidates,
    message: 'More than one worktree matches the focused one.',
    stack: null,
    shared: null
  }
  view = await mount(panel, {
    host: mockHost({
      requests: {
        'stack.get': () => unresolved,
        'workspace.pick': (input) => {
          picks.push(input)
          return { ...base, workspace: candidates[1], resolvedBy: 'pick', candidates }
        }
      }
    })
  })
  const text = view.summary().join('\n')
  assert.match(text, /Which worktree/)
  const options = view.find({ label: 'Worktree' })?.props?.options as { label: string }[]
  assert.deepEqual(options.map((o) => o.label), ['app / main - /w/app/main', 'main - /w/other/main'])
  assert.equal(view.find({ role: 'button', text: 'Up' }), null)
  assert.equal(view.find({ label: 'Restart web' }), null)
  await view.select({ label: 'Worktree' }, 'b')
  assert.deepEqual(picks, [{ workspaceId: 'b' }])
  assert.ok(view.find({ role: 'button', text: 'Up' }))
})

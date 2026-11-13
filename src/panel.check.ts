// `orca plugin check` renders the panel once per scenario. `requests` stands in for the worker,
// whose devtrees CLI is not available to check.
import { defineCheck } from 'orca/testing'
import type { StackView } from './protocol'

const up: StackView = {
  kind: 'ok',
  workspace: { id: 'repo::/work/app/feature-x', name: 'feature-x', path: '/work/app/feature-x' },
  candidates: [],
  message: null,
  stack: {
    status: 'partial',
    id: 'feature-x-3f9c2a1b',
    namespaces: ['default'],
    services: [
      { name: 'web', status: 'Running', state: 'active', health: 'ready', tier: 'isolated', ports: [{ name: 'WEB_PORT', port: 41230 }] },
      { name: 'api', status: 'Running', state: 'active', health: 'unknown', tier: 'isolated', ports: [{ name: 'API_PORT', port: 41231 }] },
      { name: 'worker', status: 'Completed', state: 'dead', health: 'unknown', tier: 'isolated', ports: [] }
    ]
  },
  shared: {
    status: 'up',
    id: 'shared',
    namespaces: ['default'],
    services: [{ name: 'postgres', status: 'Running', state: 'active', health: 'ready', tier: 'shared', ports: [{ name: 'DB_PORT', port: 50000 }] }]
  },
  busy: null,
  lastError: null,
  executable: 'devtrees'
}

const answer = (view: StackView) => ({ 'stack.get': () => view })

export default defineCheck({
  stack: { requests: answer(up) },
  busy: { requests: answer({ ...up, busy: { action: 'up', service: null, since: 0 } }) },
  down: { requests: answer({ ...up, stack: { status: 'down', id: 'feature-x-3f9c2a1b', namespaces: [], services: [] }, shared: null }) },
  failed: {
    requests: answer({ ...up, lastError: { action: 'up', code: 'HEALTH_TIMEOUT', message: 'web did not become healthy within 120s.', at: 0 } })
  },
  noConfig: { requests: answer({ ...up, kind: 'no-config', stack: null, shared: null }) },
  tooOld: { requests: answer({ ...up, kind: 'too-old', stack: null, shared: null }) },
  notInstalled: { requests: answer({ ...up, kind: 'not-installed', stack: null, shared: null }) },
  noWorkspace: { requests: answer({ ...up, kind: 'no-workspace', workspace: null, stack: null, shared: null }) }
})

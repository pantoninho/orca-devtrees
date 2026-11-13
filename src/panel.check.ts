// `orca plugin check` renders the panel once per scenario. `requests` stands in for the worker,
// whose devtrees CLI is not available to check.
import { defineCheck } from 'orca/testing'
import type { InstanceView, RowView, StackView } from './protocol'

const running = (id: string, port: number, dead = false): InstanceView => ({
  status: dead ? 'partial' : 'up',
  id,
  namespaces: ['default'],
  services: [
    { name: 'web', status: 'Running', state: 'active', health: 'ready', tier: 'isolated', ports: [{ name: 'WEB_PORT', port }] },
    { name: 'api', status: 'Running', state: 'active', health: 'unknown', tier: 'isolated', ports: [{ name: 'API_PORT', port: port + 1 }] },
    { name: 'worker', status: dead ? 'Completed' : 'Running', state: dead ? 'dead' : 'active', health: 'unknown', tier: 'isolated', ports: [] }
  ]
})
const stopped = (id: string): InstanceView => ({ status: 'down', id, namespaces: [], services: [] })
const shared: InstanceView = {
  status: 'up',
  id: 'shared',
  namespaces: ['default'],
  services: [{ name: 'postgres', status: 'Running', state: 'active', health: 'ready', tier: 'shared', ports: [{ name: 'DB_PORT', port: 50000 }] }]
}
const rowOf = (n: number, name: string, path: string, stack: InstanceView | null, project: string | null): RowView => ({
  workspace: { id: `identity:wt2:local:${n}`, name, path, branch: name, project },
  stack,
  busy: null,
  lastError: null
})

const APP_MAIN = rowOf(1, 'main', '/work/app', running('app-3f9c2a1b', 41230), 'app')
const FEATURE = rowOf(2, 'feature-x', '/work/app-wt/feature-x', running('feature-x-8d0e1f22', 41330, true), 'app')
const FIX = rowOf(3, 'fix-login', '/work/app-wt/fix-login', stopped('fix-login-0a1b2c3d'), 'app')
const OTHER_MAIN = rowOf(4, 'main', '/work/other', running('other-77aa88bb', 42230), 'other')

/** Two repos, each with a "main"; feature-x is focused. */
const many: StackView = {
  kind: 'ok',
  repos: [
    { key: '/work/app/.git', label: 'app', kind: 'ok', message: null, shared, rows: [APP_MAIN, FEATURE, FIX] },
    { key: '/work/other/.git', label: 'other', kind: 'ok', message: null, shared: null, rows: [OTHER_MAIN] }
  ],
  focusedId: FEATURE.workspace.id,
  focusUnknown: false,
  executable: 'devtrees'
}

const withRow = (v: StackView, id: string, change: Partial<RowView>): StackView => ({
  ...v,
  repos: v.repos.map((r) => ({ ...r, rows: r.rows.map((x) => (x.workspace.id === id ? { ...x, ...change } : x)) }))
})

const answer = (view: StackView) => ({ 'stack.get': () => view })

export default defineCheck({
  highlighted: { requests: answer(many) },
  noHighlight: { requests: answer({ ...many, focusedId: null }) },
  orcaMissing: { requests: answer({ ...many, focusedId: null, focusUnknown: true }) },
  oneRowBusy: {
    requests: answer(withRow(many, FEATURE.workspace.id, { busy: { action: 'up', service: null, since: 0 } }))
  },
  failed: {
    requests: answer(
      withRow(many, FEATURE.workspace.id, {
        lastError: { action: 'up', code: 'HEALTH_TIMEOUT', message: 'web did not become healthy within 120s.', at: 0 }
      })
    )
  },
  repoError: {
    requests: answer({
      ...many,
      repos: [
        many.repos[0],
        { ...many.repos[1], kind: 'error', message: 'CONFIG_INVALID: devtrees.yaml is malformed', rows: [{ ...OTHER_MAIN, stack: null }] }
      ]
    })
  },
  empty: { requests: answer({ ...many, repos: [], focusedId: null }) },
  tooOld: { requests: answer({ ...many, kind: 'too-old' }) },
  notInstalled: { requests: answer({ ...many, kind: 'not-installed' }) }
})

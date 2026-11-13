// `orca plugin check` renders the panel once per scenario. `requests` stands in for the worker,
// whose devtrees CLI is not available to check.
import { defineCheck } from 'orca/testing'
import type { InstanceView, RepoView, RowView, StackView } from './protocol'

const running = (id: string, port: number, dead = false): InstanceView => ({
  status: dead ? 'partial' : 'up',
  id,
  namespaces: ['default'],
  services: [
    { name: 'web', status: 'Running', state: 'active', health: 'ready', tier: 'isolated', ports: [{ name: 'WEB_PORT', port }] },
    {
      name: 'api',
      status: 'Running',
      state: 'active',
      health: 'unknown',
      tier: 'isolated',
      ports: [
        { name: 'API_HTTP_PORT', port: port + 1 },
        { name: 'API_DEBUG_PORT', port: port + 2 }
      ]
    },
    { name: 'worker', status: dead ? 'Completed' : 'Running', state: dead ? 'dead' : 'active', health: 'unknown', tier: 'isolated', ports: [] }
  ]
})
const stopped = (id: string): InstanceView => ({ status: 'down', id, namespaces: [], services: [] })
/** A shared instance with many ports on one service. */
const shared: InstanceView = {
  status: 'up',
  id: 'shared',
  namespaces: ['default'],
  services: [
    {
      name: 'db',
      status: 'Running',
      state: 'active',
      health: 'ready',
      tier: 'shared',
      ports: [
        { name: 'APP_SHARED_DB_PORT', port: 50000 },
        { name: 'APP_SHARED_DB_SHADOW_PORT', port: 50001 },
        { name: 'APP_SHARED_DB_POOLER_PORT', port: 50002 },
        { name: 'APP_SHARED_API_PORT', port: 50003 },
        { name: 'APP_SHARED_STUDIO_PORT', port: 50004 },
        { name: 'APP_SHARED_INBUCKET_PORT', port: 50005 }
      ]
    },
    { name: 'cache', status: 'Running', state: 'active', health: 'unknown', tier: 'shared', ports: [{ name: 'CACHE_PORT', port: 50010 }] }
  ]
}
const rowOf = (n: number, name: string, path: string, stack: InstanceView | null, project: string | null, branch = name): RowView => ({
  workspace: { id: `identity:wt2:local:${n}`, name, path, branch, project },
  stack,
  busy: null,
  lastError: null
})

const APP_MAIN = rowOf(1, 'main', '/work/app', running('app-3f9c2a1b', 41230), 'app')
const FEATURE = rowOf(2, 'feature-x', '/work/app-wt/feature-x', running('feature-x-8d0e1f22', 41330, true), 'app', 'feat/checkout-flow')
const STOPPED = ['fix-login', 'docs-pass', 'bump-deps', 'try-cache', 'old-spike'].map((name, i) =>
  rowOf(10 + i, name, `/work/app-wt/${name}`, stopped(`${name}-0a1b2c3${i}`), 'app')
)
const OTHER_MAIN = rowOf(4, 'main', '/work/other', running('other-77aa88bb', 42230), 'other')
const OTHER_IDLE = rowOf(5, 'refactor', '/work/other-wt/refactor', stopped('refactor-11aa22bb'), 'other')

const appRepo: RepoView = { key: '/work/app/.git', label: 'app', kind: 'ok', message: null, shared, rows: [APP_MAIN, ...STOPPED, FEATURE] }
const otherRepo: RepoView = { key: '/work/other/.git', label: 'other', kind: 'ok', message: null, shared: null, rows: [OTHER_MAIN, OTHER_IDLE] }

/** Two repos, each with a "main"; feature-x is focused. */
const many: StackView = {
  kind: 'ok',
  repos: [appRepo, otherRepo],
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
  /** feature-x is focused and open; five stopped rows fold into one line. */
  focused: { requests: answer(many) },
  /** One running and many stopped, nothing focused. */
  oneRunning: {
    requests: answer({ ...many, repos: [{ ...appRepo, rows: [APP_MAIN, ...STOPPED] }], focusedId: null })
  },
  /** A focused row that is stopped stays out of the fold. */
  focusedStopped: { requests: answer({ ...many, focusedId: STOPPED[0].workspace.id }) },
  /**
   * A shared instance with many ports. Its section starts closed and a check cannot open it, so
   * the focused row runs a service with the same many ports to show how they wrap.
   */
  manyPorts: {
    requests: answer(
      withRow(many, FEATURE.workspace.id, {
        stack: { ...running('feature-x-8d0e1f22', 41330), services: [...running('feature-x-8d0e1f22', 41330).services, { ...shared.services[0], tier: 'isolated' }] }
      })
    )
  },
  orcaMissing: { requests: answer({ ...many, focusedId: null, focusUnknown: true }) },
  busy: {
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
        appRepo,
        { ...otherRepo, kind: 'error', message: 'CONFIG_INVALID: devtrees.yaml is malformed', rows: otherRepo.rows.map((r) => ({ ...r, stack: null })) }
      ]
    })
  },
  empty: { requests: answer({ ...many, repos: [], focusedId: null }) },
  tooOld: { requests: answer({ ...many, kind: 'too-old' }) },
  notInstalled: { requests: answer({ ...many, kind: 'not-installed' }) }
})

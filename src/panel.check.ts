// `orca plugin check` renders the panel once per scenario. `requests` stands in for the worker,
// whose devtrees CLI is not available to check.
import { defineCheck } from 'orca/testing'
import type { InstanceView, RepoView, RowView, ServiceView, StackView } from './protocol'

const svc = (name: string, ports: [string, number][], change: Partial<ServiceView> = {}): ServiceView => ({
  name,
  status: 'Running',
  state: 'active',
  health: 'ready',
  tier: 'isolated',
  ports: ports.map(([n, port]) => ({ name: n, port })),
  ...change
})

/** web, api and worker; with `dead`, worker has exited. */
const running = (id: string, port: number, dead = false): InstanceView => ({
  status: dead ? 'partial' : 'up',
  id,
  namespaces: ['default'],
  services: [
    svc('web', [['WEB_PORT', port]]),
    svc('api', [['API_HTTP_PORT', port + 1], ['API_DEBUG_PORT', port + 2]], { health: 'unknown' }),
    svc('worker', [], dead ? { status: 'Completed', state: 'dead', health: 'unknown' } : { health: 'unknown' })
  ]
})
const stopped = (id: string): InstanceView => ({ status: 'down', id, namespaces: [], services: [] })
/** The fixture repo's shared tier: one cache. */
const fixtureShared: InstanceView = {
  status: 'up',
  id: 'shared',
  namespaces: ['default'],
  services: [svc('cache', [['CACHE_PORT', 50000]], { tier: 'shared', health: 'unknown' })]
}
/** demo-app's shared tier: a database with many ports. */
const demoShared: InstanceView = {
  status: 'up',
  id: 'shared',
  namespaces: ['default'],
  services: [
    svc(
      'db',
      [
        ['DEMO_SHARED_DB_PORT', 51000],
        ['DEMO_SHARED_DB_SHADOW_PORT', 51001],
        ['DEMO_SHARED_API_PORT', 51002],
        ['DEMO_SHARED_STUDIO_PORT', 51003]
      ],
      { tier: 'shared' }
    )
  ]
}
const rowOf = (n: number, name: string, path: string, stack: InstanceView | null, project: string, branch: string | null = name): RowView => ({
  workspace: { id: `identity:wt2:local:${n}`, name, path, branch, project },
  stack,
  busy: null,
  lastError: null
})

const FIXTURE_MAIN = rowOf(1, 'main', '/work/devtrees-fixture', running('main-3f9c2a1b', 41230), 'devtrees-fixture')
const FIXTURE_DOCS = rowOf(2, 'docs-pass', '/work/devtrees-fixture-wt/docs-pass', stopped('docs-pass-0a1b2c30'), 'devtrees-fixture')
const FEAT_X = rowOf(3, 'feat-x', '/work/demo-app-wt/feat-x', running('feat-x-8d0e1f22', 42330), 'demo-app')
const FIX_Y = rowOf(4, 'fix-y', '/work/demo-app-wt/fix-y', running('fix-y-8d0e1f23', 42430, true), 'demo-app')
const STOPPED = ['fix-login', 'bump-deps', 'try-cache', 'old-spike', 'refactor'].map((name, i) =>
  rowOf(10 + i, name, `/work/demo-app-wt/${name}`, stopped(`${name}-0a1b2c3${i}`), 'demo-app')
)

const fixture: RepoView = {
  key: '/work/devtrees-fixture/.git',
  label: 'devtrees-fixture',
  kind: 'ok',
  message: null,
  shared: fixtureShared,
  rows: [FIXTURE_MAIN, FIXTURE_DOCS]
}
const demo: RepoView = {
  key: '/work/demo-app/.git',
  label: 'demo-app',
  kind: 'ok',
  message: null,
  shared: demoShared,
  rows: [FEAT_X, FIX_Y, ...STOPPED]
}

/** devtrees-fixture's main is focused and up; demo-app runs two worktrees and its shared instance; six are stopped. */
const many: StackView = {
  kind: 'ok',
  repos: [fixture, demo],
  focusedId: FIXTURE_MAIN.workspace.id,
  focusUnknown: false,
  executable: 'devtrees'
}

const withRow = (v: StackView, id: string, change: Partial<RowView>): StackView => ({
  ...v,
  repos: v.repos.map((r) => ({ ...r, rows: r.rows.map((x) => (x.workspace.id === id ? { ...x, ...change } : x)) }))
})

const answer = (view: StackView) => ({ 'stack.get': () => view })

export default defineCheck({
  /** The focused worktree runs: title, actions, its services and the shared cache; below, running others and a shared instance. */
  focusedRunning: { requests: answer(many) },
  /** The focused worktree is stopped: its services greyed, borrowed from a sibling; only Up stands out. */
  focusedDown: {
    requests: answer({ ...many, repos: [fixture, demo], focusedId: FIXTURE_DOCS.workspace.id })
  },
  /** Nothing focused: only the running list and the stopped line. */
  noFocus: { requests: answer({ ...many, focusedId: null }) },
  /** The orca CLI could not be run: like no focus, with a note. */
  focusUnknown: { requests: answer({ ...many, focusedId: null, focusUnknown: true }) },
  /** Running others and a shared instance, the focused repo's shared one not repeated. */
  runningWithShared: { requests: answer({ ...many, repos: [fixture, { ...demo, rows: [FEAT_X, FIX_Y] }] }) },
  /** Only stopped worktrees besides the focused one: one dim "N stopped" line. */
  onlyStopped: { requests: answer({ ...many, repos: [fixture, { ...demo, shared: null, rows: STOPPED }] }) },
  busy: {
    requests: answer(withRow(many, FIXTURE_MAIN.workspace.id, { busy: { action: 'up', service: null, since: 0 } }))
  },
  failed: {
    requests: answer(
      withRow(many, FIXTURE_MAIN.workspace.id, {
        lastError: { action: 'up', code: 'HEALTH_TIMEOUT', message: 'web did not become healthy within 120s.', at: 0 }
      })
    )
  },
  repoError: {
    requests: answer({
      ...many,
      repos: [fixture, { ...demo, kind: 'error', message: 'CONFIG_INVALID: devtrees.yaml is malformed', shared: null, rows: demo.rows.map((r) => ({ ...r, stack: null })) }]
    })
  },
  empty: { requests: answer({ ...many, repos: [], focusedId: null }) },
  tooOld: { requests: answer({ ...many, kind: 'too-old' }) },
  notInstalled: { requests: answer({ ...many, kind: 'not-installed' }) }
})

import { assert, test } from 'orca/testing'
import { failureOf, readLs, repoLabel, stackOf, worktreeIdOf } from './devtrees'
import { idOf, lsRepo, sha256 } from './fake-runner'

test('derives the worktree id the way devtrees does', () => {
  // Printed by `devtrees env --json` (DEVTREES_WORKTREE_ID) for this path, devtrees 0.6.0.
  const path = '/Users/pantoninho/dev/self/devtrees/.claude/worktrees/agent-a7f162ef44aec842d/.claude/worktrees/fixture'
  assert.equal(worktreeIdOf(path, sha256), 'fixture-d35e730d')
  assert.equal(worktreeIdOf(`${path}/`, sha256), 'fixture-d35e730d')
  assert.match(worktreeIdOf('/x/Feature.X', sha256), /^feature-x-[0-9a-f]{8}$/)
  assert.match(worktreeIdOf('/x/__', sha256), /^wt-[0-9a-f]{8}$/)
})

test('reads a stack that is not listed as down', () => {
  const ls = readLs('{"ls":{"instances":[],"shared_ports":{}}}')
  assert.deepEqual(ls, { worktrees: {}, shared: null })
  assert.deepEqual(stackOf(ls!, 'a-1'), { status: 'down', id: 'a-1', namespaces: [], services: [] })
  assert.equal(readLs('not json'), null)
})

test('one ls gives every worktree instance of the repo, by worktree id', () => {
  const ls = readLs(JSON.stringify(lsRepo(['/w/app/main', '/w/app/feature-x'])))!
  assert.deepEqual(Object.keys(ls.worktrees).sort(), [idOf('/w/app/feature-x'), idOf('/w/app/main')].sort())
  assert.equal(stackOf(ls, idOf('/w/app/main')).status, 'up')
  assert.equal(stackOf(ls, idOf('/w/app/other')).status, 'down')
  assert.equal(ls.shared?.id, 'shared')
})

test('labels a repo with its Orca project, else its main checkout or bare repo name', () => {
  assert.equal(repoLabel('/w/app/.git', 'App'), 'App')
  assert.equal(repoLabel('/w/app/.git', null), 'app')
  assert.equal(repoLabel('/w/app/.git', ''), 'app')
  assert.equal(repoLabel('/w/bare/app.git', null), 'app')
  assert.equal(repoLabel('/w/loose', null), 'loose')
})

test('reads an unresponsive instance as unknown', () => {
  const doc = { ls: { instances: [{ id: 'a-1', kind: 'worktree', status: 'running', services_read: 'unresponsive', services: [] }] } }
  assert.equal(stackOf(readLs(JSON.stringify(doc))!, 'a-1').status, 'unknown')
})

test('classifies failures', () => {
  assert.deepEqual(failureOf({ code: null, stdout: '', stderr: '', notFound: true }), { kind: 'not-installed' })
  assert.deepEqual(
    failureOf({ code: 1, stdout: 'Unknown Syntax Error: Unsupported option name ("--services").', stderr: '', notFound: false }),
    { kind: 'too-old' }
  )
  assert.deepEqual(failureOf({ code: 1, stdout: '', stderr: 'devtrees: boom\nmore', notFound: false }), {
    kind: 'error',
    code: 'UNKNOWN',
    message: 'boom'
  })
})

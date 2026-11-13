import { assert, test } from 'orca/testing'
import { failureOf, readLs, worktreeIdOf } from './devtrees'
import { sha256 } from './fake-runner'

test('derives the worktree id the way devtrees does', () => {
  // Printed by `devtrees env --json` (DEVTREES_WORKTREE_ID) for this path, devtrees 0.6.0.
  const path = '/Users/pantoninho/dev/self/devtrees/.claude/worktrees/agent-a7f162ef44aec842d/.claude/worktrees/fixture'
  assert.equal(worktreeIdOf(path, sha256), 'fixture-d35e730d')
  assert.equal(worktreeIdOf(`${path}/`, sha256), 'fixture-d35e730d')
  assert.match(worktreeIdOf('/x/Feature.X', sha256), /^feature-x-[0-9a-f]{8}$/)
  assert.match(worktreeIdOf('/x/__', sha256), /^wt-[0-9a-f]{8}$/)
})

test('reads a stack that is not up as down', () => {
  const ls = readLs('{"ls":{"instances":[],"shared_ports":{}}}', 'a-1')
  assert.deepEqual(ls, { stack: { status: 'down', id: 'a-1', namespaces: [], services: [] }, shared: null })
  assert.equal(readLs('not json', 'a-1'), null)
})

test('reads an unresponsive instance as unknown', () => {
  const doc = { ls: { instances: [{ id: 'a-1', kind: 'worktree', status: 'running', services_read: 'unresponsive', services: [] }] } }
  assert.equal(readLs(JSON.stringify(doc), 'a-1')?.stack.status, 'unknown')
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

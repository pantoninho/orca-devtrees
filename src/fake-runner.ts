// A stand-in for the devtrees, orca and git CLIs and the file system, for the worker tests.
import { createHash } from 'node:crypto'
import { worktreeIdOf, type RunOptions, type RunResult, type Runner } from './devtrees'

export type Call = { executable: string; args: string[]; cwd: string; detached: boolean }
type Reply = Partial<RunResult> | ((call: Call) => Partial<RunResult>)

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
export const idOf = (path: string) => worktreeIdOf(path, sha256)

export const ok = (doc: unknown): Partial<RunResult> => ({ code: 0, stdout: `${JSON.stringify(doc)}\n` })
export const fail = (code: string, message: string): Partial<RunResult> => ({
  code: 1,
  stdout: `${JSON.stringify({ schema_version: '1', error: { code, message } })}\n`,
  stderr: `devtrees: ${message}\n`
})

/** `ls --services --json` with one running worktree instance and the shared instance. */
export function lsRunning(path: string, extra: { dead?: string[] } = {}) {
  const dead = new Set(extra.dead ?? [])
  return {
    schema_version: '1',
    ls: {
      instances: [
        {
          id: 'shared',
          kind: 'shared',
          status: 'running',
          ports: { CACHE_PORT: 60672 },
          namespaces: ['default'],
          services_read: 'ok',
          reload_pending: false,
          services: [
            { name: 'cache', status: 'Running', health: 'unknown', ports: { CACHE_PORT: 60672 }, namespaces: ['default'], tier: 'shared', state: 'active', pid: 1 }
          ]
        },
        {
          id: idOf(path),
          kind: 'worktree',
          status: 'running',
          ports: { WEB_PORT: 38176, CACHE_PORT: 60672 },
          namespaces: ['default', 'app'],
          services_read: 'ok',
          reload_pending: false,
          services: [
            { name: 'web', status: dead.has('web') ? 'Completed' : 'Running', health: 'ready', ports: { WEB_PORT: 38176 }, namespaces: ['default'], tier: 'isolated', state: dead.has('web') ? 'dead' : 'active', pid: 2 },
            { name: 'worker', status: 'Running', health: 'unknown', ports: {}, namespaces: ['app'], tier: 'isolated', state: 'active', pid: 3 }
          ]
        }
      ],
      shared_ports: {}
    }
  }
}

export const lsEmpty = { schema_version: '1', ls: { instances: [], shared_ports: {} } }

/** One `orca terminal list --json` row: a terminal handle and the worktree it runs in. */
export const terminal = (handle: string, worktreePath: string, executionHostId = 'local') => ({
  handle,
  worktreePath,
  worktreeId: `repo::${worktreePath}`,
  executionHostId,
  title: 'zsh',
  preview: 'x'.repeat(200)
})

/** Subcommands of the orca and git CLIs, which are not devtrees. */
const LOOKUPS = new Set(['terminal', 'rev-parse'])

export class FakeRunner implements Runner {
  calls: Call[] = []
  files = new Set<string>()
  replies = new Map<string, Reply>()
  /** What `orca terminal list --json` lists; null makes it fail. */
  terminals: ReturnType<typeof terminal>[] | null = []
  /** `git rev-parse --git-common-dir` by cwd; a cwd not listed fails as outside a repo. */
  commonDirs = new Map<string, string>()
  /** Replies to commands still running, released by `release()`. */
  private held: (() => void)[] = []
  hold = false

  /** Sets the reply for a subcommand (`ls`, `up`, ...). */
  on(subcommand: string, reply: Reply): this {
    this.replies.set(subcommand, reply)
    return this
  }

  release(): void {
    for (const go of this.held.splice(0)) go()
  }

  async run(executable: string, args: string[], { cwd, detached = false }: RunOptions): Promise<RunResult> {
    const call = { executable, args, cwd, detached }
    this.calls.push(call)
    if (this.hold && args[0] !== 'ls' && !LOOKUPS.has(args[0])) await new Promise<void>((go) => this.held.push(go))
    const reply = this.replies.get(args[0]) ?? this.lookup(call) ?? { code: 0, stdout: '{}' }
    const value = typeof reply === 'function' ? reply(call) : reply
    return { code: 0, stdout: '', stderr: '', notFound: false, ...value }
  }

  private lookup(call: Call): Partial<RunResult> | null {
    if (call.args[0] === 'terminal') {
      if (this.terminals === null) return { code: 1, stderr: 'orca: not running' }
      const doc = { id: 'x', ok: true, result: { terminals: this.terminals } }
      return { code: 0, stdout: `${JSON.stringify(doc, null, 2)}\n` }
    }
    if (call.args[0] === 'rev-parse') {
      const dir = this.commonDirs.get(call.cwd)
      return dir === undefined ? { code: 128, stderr: 'fatal: not a git repository' } : { code: 0, stdout: `${dir}\n` }
    }
    return null
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }

  async realpath(path: string): Promise<string> {
    return path
  }

  sha256 = sha256

  /** The devtrees calls so far, without the orca and git lookups. */
  get devtrees(): Call[] {
    return this.calls.filter((c) => !LOOKUPS.has(c.args[0]))
  }

  /** The devtrees subcommands run so far, such as `['ls --services --json', 'up ...']`. */
  get commands(): string[] {
    return this.devtrees.map((c) => c.args.join(' '))
  }
}

/** Waits for a condition the worker reaches in the background. */
export async function until(check: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((done) => setTimeout(done, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

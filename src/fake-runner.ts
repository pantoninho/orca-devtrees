// A stand-in for the devtrees CLI and the file system, for the worker tests.
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

export class FakeRunner implements Runner {
  calls: Call[] = []
  files = new Set<string>()
  replies = new Map<string, Reply>()
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
    if (this.hold && args[0] !== 'ls') await new Promise<void>((go) => this.held.push(go))
    const reply = this.replies.get(args[0]) ?? { code: 0, stdout: '{}' }
    const value = typeof reply === 'function' ? reply(call) : reply
    return { code: 0, stdout: '', stderr: '', notFound: false, ...value }
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }

  async realpath(path: string): Promise<string> {
    return path
  }

  sha256 = sha256

  /** The subcommands run so far, such as `['ls', 'up']`. */
  get commands(): string[] {
    return this.calls.map((c) => c.args.join(' '))
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

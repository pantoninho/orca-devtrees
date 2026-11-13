// The few Node APIs src/node-runner.ts uses. The plugin has no npm dependencies, so this
// stands in for @types/node.
declare module 'node:child_process' {
  interface Readable {
    on(event: 'data', listener: (chunk: { toString(): string }) => void): void
  }
  interface ChildProcess {
    stdout: Readable | null
    stderr: Readable | null
    on(event: 'error', listener: (error: Error & { code?: string }) => void): void
    on(event: 'close', listener: (code: number | null) => void): void
    unref(): void
    kill(): boolean
  }
  export function spawn(
    command: string,
    args: readonly string[],
    options: { cwd?: string; detached?: boolean; stdio?: readonly string[] }
  ): ChildProcess
}

declare module 'node:fs/promises' {
  export function access(path: string): Promise<void>
  export function realpath(path: string): Promise<string>
}

declare module 'node:crypto' {
  interface Hash {
    update(data: string): Hash
    digest(encoding: 'hex'): string
  }
  export function createHash(algorithm: string): Hash
}

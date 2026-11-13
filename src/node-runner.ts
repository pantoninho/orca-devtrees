// The real Runner: spawns the devtrees CLI and reads the file system.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, realpath } from 'node:fs/promises'
import type { RunResult, Runner } from './devtrees'

/** Output beyond this is dropped; devtrees' JSON is far smaller. */
const MAX_OUTPUT = 4 * 1024 * 1024

export const nodeRunner: Runner = {
  run(executable, args, { cwd, detached = false }) {
    return new Promise<RunResult>((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (result: RunResult) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      // `detached` puts the CLI in its own process group: when Orca restarts the worker, the
      // command still finishes. process-compose itself is always detached by devtrees.
      const child = spawn(executable, args, { cwd, detached, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout?.on('data', (chunk) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk) => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk.toString()
      })
      child.on('error', (error) => {
        finish({ code: null, stdout, stderr: stderr || error.message, notFound: error.code === 'ENOENT' })
      })
      child.on('close', (code) => finish({ code, stdout, stderr, notFound: false }))
    })
  },
  async exists(path) {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  },
  async realpath(path) {
    try {
      return await realpath(path)
    } catch {
      return path
    }
  },
  sha256(text) {
    return createHash('sha256').update(text).digest('hex')
  }
}

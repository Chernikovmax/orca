import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { resolveGitDir } from './resolve-git-dir'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { GitRuntimeOptions } from '../git-runtime-options'

/**
 * One conservative write queue per repository, keyed by the *common* Git dir so
 * linked worktrees of the same repository share it. External writers (CLI, IDE,
 * agents) are never blocked by this queue; Git's own locks and the expected-state
 * checks are what detect them.
 */
const chains = new Map<string, Promise<unknown>>()
const held = new AsyncLocalStorage<string>()
/**
 * Key resolution is async (it reads the Git metadata pointer), so without this
 * acquisition order two concurrent calls could resolve in reverse order and invert
 * the queue. Slots are cheap filesystem work, not the writes themselves.
 */
let acquisitionTail: Promise<unknown> = Promise.resolve()

export async function resolveCommonGitDir(
  worktreePath: string,
  options: Pick<GitRuntimeOptions, 'wslDistro'> = {}
): Promise<string> {
  const gitDir = path.resolve(await resolveGitDir(worktreePath, options))
  try {
    const pointer = (await readFile(path.join(gitDir, 'commondir'), 'utf8')).trim()
    if (pointer) {
      return path.resolve(gitDir, pointer)
    }
  } catch {
    // No `commondir`: this checkout owns its own repository metadata.
  }
  return gitDir
}

async function queueKey(
  worktreePath: string,
  options: Pick<GitRuntimeOptions, 'wslDistro'>
): Promise<string> {
  return `${options.wslDistro ?? ''}\0${normalizeRuntimePathForComparison(
    await resolveCommonGitDir(worktreePath, options)
  )}`
}

/**
 * Serialize Orca-initiated writes for one repository. Nested calls already holding
 * the same queue run inline; acquiring a *different* repository's queue inside an
 * operation would hold two queues and is refused explicitly.
 */
export async function withGitMutationQueue<T>(
  worktreePath: string,
  options: Pick<GitRuntimeOptions, 'wslDistro'>,
  run: () => Promise<T>
): Promise<T> {
  const acquisition = acquisitionTail.catch(() => {}).then(() => queueKey(worktreePath, options))
  acquisitionTail = acquisition
  const key = await acquisition
  const current = held.getStore()
  if (current !== undefined) {
    if (current === key) {
      return run()
    }
    throw new Error('Refusing to hold two Git mutation queues in one operation')
  }
  const previous = chains.get(key) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(() => held.run(key, run))
  chains.set(key, operation)
  try {
    return await operation
  } finally {
    if (chains.get(key) === operation) {
      chains.delete(key)
    }
  }
}

/** Test/diagnostics helper: whether a queue currently has a running or waiting write. */
export function gitMutationQueueSize(): number {
  return chains.size
}

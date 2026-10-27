import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  gitMutationQueueSize,
  resolveCommonGitDir,
  withGitMutationQueue
} from './git-mutation-queue'

const roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'orca-mutation-queue-'))
  roots.push(dir)
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 'queue@example.invalid'])
  git(dir, ['config', 'user.name', 'Queue Test'])
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'initial'])
  return dir
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('withGitMutationQueue', () => {
  it('shares one queue between a worktree and its linked checkouts', async () => {
    const repo = await createRepo()
    const linked = path.join(path.dirname(repo), `${path.basename(repo)}-linked`)
    roots.push(linked)
    git(repo, ['worktree', 'add', '-q', '-b', 'linked', linked])
    const [repoDir, linkedDir] = await Promise.all([
      resolveCommonGitDir(repo),
      resolveCommonGitDir(linked)
    ])
    // Why realpath: macOS /var is a symlink to /private/var and both spellings are the same dir.
    expect(await realpath(repoDir)).toBe(await realpath(linkedDir))
  })

  it('serializes writes for the same common git dir', async () => {
    const repo = await createRepo()
    const events: string[] = []
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const first = withGitMutationQueue(repo, {}, async () => {
      events.push('first:start')
      started.resolve()
      await gate.promise
      events.push('first:end')
    })
    const second = withGitMutationQueue(repo, {}, async () => {
      events.push('second:start')
      events.push('second:end')
    })
    await started.promise
    expect(events).toEqual(['first:start'])
    gate.resolve()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
    expect(gitMutationQueueSize()).toBe(0)
  })

  it('runs nested calls for the same repository inline', async () => {
    const repo = await createRepo()
    const events: string[] = []
    await withGitMutationQueue(repo, {}, async () => {
      events.push('outer')
      await withGitMutationQueue(repo, {}, async () => {
        events.push('inner')
      })
    })
    expect(events).toEqual(['outer', 'inner'])
  })

  it('refuses to hold two repositories queues at once', async () => {
    const first = await createRepo()
    const second = await createRepo()
    await expect(
      withGitMutationQueue(first, {}, async () => {
        await withGitMutationQueue(second, {}, async () => {})
      })
    ).rejects.toThrow('Refusing to hold two Git mutation queues in one operation')
  })
})

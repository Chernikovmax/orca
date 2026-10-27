import { readFile, rm, utimes, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitWorkspaceFixture, type GitWorkspaceFixture } from './source-control/git-workspace-test-fixture'
import { getDiff, invalidateGitReadCaches } from './status'
import { settledDiffCache } from './source-control/git-read-cache-invalidation'

let fixture: GitWorkspaceFixture
beforeEach(async () => {
  fixture = await createGitWorkspaceFixture()
  for (const key of ['HOME', 'USERPROFILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT'] as const) {
    vi.stubEnv(key, fixture.env[key])
  }
  invalidateGitReadCaches()
  settledDiffCache.resetStatsForTests()
}, 30_000)
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(fixture.directory, { recursive: true, force: true })
})

async function settleInputs() {
  const date = new Date(Date.now() - 60_000)
  for (const relative of ['file.txt', '.git/HEAD', '.git/index', '.gitmodules']) {
    await utimes(path.join(fixture.root, relative), date, date)
  }
}

describe('settled diff cache with real external Git mutations', () => {
  it('does not reuse cached text after external edits, staging or HEAD moves', async () => {
    await writeFile(path.join(fixture.root, 'file.txt'), 'first working\n')
    await settleInputs()
    const first = await getDiff(fixture.root, 'file.txt', false)
    expect(first).toMatchObject({ originalContent: 'root initial\n', modifiedContent: 'first working\n' })
    await getDiff(fixture.root, 'file.txt', false)
    expect(settledDiffCache.stats().hits).toBe(1)
    await writeFile(path.join(fixture.root, 'file.txt'), 'external edit\n')
    expect(await getDiff(fixture.root, 'file.txt', false)).toMatchObject({ originalContent: 'root initial\n', modifiedContent: 'external edit\n' })
    await fixture.git(fixture.root, ['add', 'file.txt'])
    expect(await getDiff(fixture.root, 'file.txt', false)).toMatchObject({ originalContent: 'external edit\n', modifiedContent: 'external edit\n' })
    expect(await getDiff(fixture.root, 'file.txt', true)).toMatchObject({ originalContent: 'root initial\n', modifiedContent: 'external edit\n' })
    await fixture.git(fixture.root, ['commit', '-qm', 'external commit'])
    expect(await getDiff(fixture.root, 'file.txt', true)).toMatchObject({ originalContent: 'external edit\n', modifiedContent: 'external edit\n' })
  }, 30_000)

  it('keeps staged snapshots independent from worktree bytes and linked worktrees', async () => {
    await writeFile(path.join(fixture.root, 'file.txt'), 'staged root\n')
    await fixture.git(fixture.root, ['add', 'file.txt'])
    await settleInputs()
    expect(await getDiff(fixture.root, 'file.txt', true)).toMatchObject({ originalContent: 'root initial\n', modifiedContent: 'staged root\n' })
    await writeFile(path.join(fixture.root, 'file.txt'), 'later unstaged\n')
    expect(await getDiff(fixture.root, 'file.txt', true)).toMatchObject({ originalContent: 'root initial\n', modifiedContent: 'staged root\n' })
    expect(settledDiffCache.stats().hits).toBe(1)
    await writeFile(path.join(fixture.second, 'file.txt'), 'second checkout\n')
    expect(await getDiff(fixture.second, 'file.txt', false)).toMatchObject({ originalContent: 'root initial\n', modifiedContent: 'second checkout\n' })
    expect(await readFile(path.join(fixture.root, 'file.txt'), 'utf8')).toBe('later unstaged\n')
  }, 30_000)
})

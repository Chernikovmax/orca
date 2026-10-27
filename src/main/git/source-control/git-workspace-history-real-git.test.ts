import { mkdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getStatus } from './status-read'
import {
  getWorkspaceCommitCompare,
  getWorkspaceHistory
} from './git-workspace-history'
import { createGitWorkspaceFixture, type GitWorkspaceFixture } from './git-workspace-test-fixture'

const TEST_TIMEOUT = 120_000

let fixture: GitWorkspaceFixture
let rootContextId: string
let oneContextId: string

async function rootContextOf(worktreePath: string): Promise<string> {
  const status = await getStatus(worktreePath, {
    includeWorkspace: true,
    includeLineStats: false
  })
  const contextId = status.workspace?.rootContextId
  if (!contextId) {
    throw new Error('fixture discovery returned no root context')
  }
  return contextId
}

async function contextAt(root: string, checkoutPath: string): Promise<string> {
  const status = await getStatus(root, {
    includeWorkspace: true,
    includeLineStats: false
  })
  const canonical = await realpath(checkoutPath)
  const repository = status.workspace?.repositories.find(
    (item) => item.context.checkoutPath === canonical
  )
  if (!repository) {
    throw new Error(`fixture discovery returned no context for ${checkoutPath}`)
  }
  return repository.context.id
}

async function commitFile(cwd: string, file: string, content: string, message: string): Promise<string> {
  const target = path.join(cwd, file)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
  await fixture.git(cwd, ['add', file])
  await fixture.git(cwd, ['commit', '-qm', message])
  return fixture.git(cwd, ['rev-parse', 'HEAD'])
}

beforeAll(async () => {
  fixture = await createGitWorkspaceFixture()
  rootContextId = await rootContextOf(fixture.root)
  oneContextId = await contextAt(fixture.root, fixture.one)
}, TEST_TIMEOUT)

afterAll(async () => {
  await rm(fixture.directory, { recursive: true, force: true })
})

describe('workspace history', { timeout: TEST_TIMEOUT }, () => {
  it('pages a pinned real history without duplicates or gaps', async () => {
    for (let index = 0; index < 130; index += 1) {
      await commitFile(fixture.one, `paged/${index}.txt`, `${index}\n`, `paged ${index}`)
    }
    const expected = (await fixture.git(fixture.one, ['rev-list', '--topo-order', 'HEAD'])).split('\n')
    const first = await getWorkspaceHistory(fixture.root, {
      contextId: oneContextId,
      limit: 50
    })
    expect(first.items).toHaveLength(50)
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).toEqual({ tipOid: first.tipOid, offset: 50 })
    expect(first.generation).toBeTruthy()

    const second = await getWorkspaceHistory(fixture.root, {
      contextId: oneContextId,
      limit: 50,
      cursor: first.nextCursor
    })
    expect(second.generation).toBe(first.generation)
    expect(second.tipOid).toBe(first.tipOid)

    // Why: a commit created after page one must not shift the pinned walk.
    const external = await commitFile(fixture.one, 'paged/external.txt', 'external\n', 'external commit')
    const pages = [first, second]
    let cursor = second.nextCursor
    while (cursor) {
      const page = await getWorkspaceHistory(fixture.root, {
        contextId: oneContextId,
        limit: 50,
        cursor
      })
      expect(page.generation).toBe(first.generation)
      pages.push(page)
      cursor = page.nextCursor
    }
    const ids = pages.flatMap((page) => page.items.map((item) => item.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expected)

    const reloaded = await getWorkspaceHistory(fixture.root, {
      contextId: oneContextId,
      limit: 50
    })
    expect(reloaded.tipOid).toBe(external)
    expect(reloaded.generation).not.toBe(first.generation)
    expect(reloaded.items[0]?.id).toBe(external)
  })

  it('rejects a continuation without a full pinned object id', async () => {
    await expect(
      getWorkspaceHistory(fixture.root, {
        contextId: rootContextId,
        cursor: { tipOid: 'HEAD', offset: 0 }
      })
    ).rejects.toThrow(/full commit id/i)
    await expect(
      getWorkspaceHistory(fixture.root, {
        contextId: rootContextId,
        cursor: { tipOid: 'a'.repeat(40), offset: 5001 }
      })
    ).rejects.toThrow(/stop after 5000 loaded commits/i)
  })

  it('keeps merge parents and compares against the chosen parent', async () => {
    const base = await fixture.git(fixture.root, ['rev-parse', 'HEAD'])
    await fixture.git(fixture.root, ['checkout', '-b', 'merge-side'])
    const sideOid = await commitFile(fixture.root, 'side-only.txt', 'side\n', 'side change')
    await fixture.git(fixture.root, ['checkout', 'main'])
    const mainOid = await commitFile(fixture.root, 'main-only.txt', 'main\n', 'main change')
    await fixture.git(fixture.root, [
      '-c',
      'user.name=Workspace Test',
      '-c',
      'user.email=workspace@example.invalid',
      'merge',
      '--no-ff',
      '-m',
      'merge side',
      'merge-side'
    ])
    const mergeOid = await fixture.git(fixture.root, ['rev-parse', 'HEAD'])
    const history = await getWorkspaceHistory(fixture.root, {
      contextId: rootContextId,
      limit: 10
    })
    const merge = history.items.find((item) => item.id === mergeOid)
    expect(merge?.parentIds).toEqual([mainOid, sideOid])
    expect(merge?.subject).toBe('merge side')
    expect(base).toBeTruthy()

    const firstParent = await getWorkspaceCommitCompare(
      fixture.root,
      { contextId: rootContextId, commitOid: mergeOid, baseOid: mainOid }
    )
    expect(firstParent.summary.status).toBe('ready')
    expect(firstParent.entries.map((entry) => entry.path)).toContain('side-only.txt')
    expect(firstParent.entries.map((entry) => entry.path)).not.toContain('main-only.txt')

    const secondParent = await getWorkspaceCommitCompare(
      fixture.root,
      { contextId: rootContextId, commitOid: mergeOid, baseOid: sideOid }
    )
    expect(secondParent.entries.map((entry) => entry.path)).toContain('main-only.txt')
    expect(secondParent.entries.map((entry) => entry.path)).not.toContain('side-only.txt')

    await expect(
      getWorkspaceCommitCompare(fixture.root, {
        contextId: rootContextId,
        commitOid: mergeOid,
        baseOid: 'b'.repeat(40)
      })
    ).resolves.toMatchObject({
      summary: { status: 'invalid-base', errorMessage: expect.stringMatching(/no fetch/i) }
    })
  })

  it('filters by path and by message without changing the pinned walk', async () => {
    await commitFile(fixture.root, 'filter/alpha.txt', 'alpha\n', 'feat: alpha topic')
    const betaOid = await commitFile(fixture.root, 'filter/beta.txt', 'beta\n', 'fix: beta topic')

    const byPath = await getWorkspaceHistory(fixture.root, {
      contextId: rootContextId,
      limit: 20,
      path: 'filter/alpha.txt'
    })
    expect(byPath.items.map((item) => item.subject)).toEqual(['feat: alpha topic'])
    expect(byPath.tipOid).toBe(await fixture.git(fixture.root, ['rev-parse', 'HEAD']))

    const byMessage = await getWorkspaceHistory(fixture.root, {
      contextId: rootContextId,
      limit: 20,
      message: 'BETA TOPIC'
    })
    expect(byMessage.items.map((item) => item.id)).toEqual([betaOid])

    await expect(
      getWorkspaceHistory(fixture.root, {
        contextId: rootContextId,
        path: '../escape'
      })
    ).rejects.toThrow(/invalid path filter/i)
  })

  it('reads a child checkout history and commit files instead of the parent', async () => {
    const childHistory = await getWorkspaceHistory(fixture.root, {
      contextId: oneContextId,
      limit: 100
    })
    const rootHistory = await getWorkspaceHistory(fixture.root, {
      contextId: rootContextId,
      limit: 100
    })
    expect(childHistory.tipOid).toBe(await fixture.git(fixture.one, ['rev-parse', 'HEAD']))
    expect(rootHistory.tipOid).toBe(await fixture.git(fixture.root, ['rev-parse', 'HEAD']))
    const rootIds = new Set(rootHistory.items.map((item) => item.id))
    expect(childHistory.items.some((item) => rootIds.has(item.id))).toBe(false)

    const childHead = childHistory.items[0]!
    const files = await getWorkspaceCommitCompare(fixture.root, {
      contextId: oneContextId,
      commitOid: childHead.id
    })
    expect(files.summary.status).toBe('ready')
    expect(files.entries.some((entry) => entry.path.startsWith('paged/'))).toBe(true)
    expect(files.entries.some((entry) => entry.path === 'one')).toBe(false)
  })

  it('rejects a context borrowed from another worktree', async () => {
    const secondContextId = await rootContextOf(fixture.second)
    await expect(
      getWorkspaceHistory(fixture.root, { contextId: secondContextId, limit: 5 })
    ).rejects.toThrow(/not part of this authorized worktree/i)
    await expect(
      getWorkspaceHistory(fixture.root, { contextId: 'ctx-not-issued', limit: 5 })
    ).rejects.toThrow(/not part of this authorized worktree/i)
  })

  it('isolates histories of two worktrees of one repository', async () => {
    const secondContextId = await rootContextOf(fixture.second)
    const secondOnly = await commitFile(fixture.second, 'second-only.txt', 'second\n', 'second only')
    const secondHistory = await getWorkspaceHistory(fixture.second, {
      contextId: secondContextId,
      limit: 10
    })
    const rootHistory = await getWorkspaceHistory(fixture.root, {
      contextId: rootContextId,
      limit: 10
    })
    expect(secondHistory.items[0]?.id).toBe(secondOnly)
    expect(rootHistory.items.some((item) => item.id === secondOnly)).toBe(false)
  })

  it('returns an empty result for an unborn checkout and an explicit error for missing commits', async () => {
    const unborn = path.join(fixture.directory, 'unborn')
    await mkdir(unborn)
    await fixture.git(unborn, ['init', '-q'])
    const empty = await getWorkspaceHistory(unborn, { limit: 10 })
    expect(empty).toMatchObject({ items: [], empty: true, hasMore: false, tipOid: '' })
    expect(empty.generation).toBeTruthy()

    const detachedRoot = await rootContextOf(unborn)
    await expect(
      getWorkspaceHistory(unborn, { contextId: detachedRoot, revision: 'NoSuchRef' })
    ).rejects.toThrow(/not available locally; no fetch was attempted/i)
  })

  it('reports detached HEAD explicitly in a real worktree', async () => {
    const detached = path.join(fixture.directory, 'detached')
    await fixture.git(fixture.root, ['worktree', 'add', '--detach', detached, 'HEAD~1'])
    const contextId = await rootContextOf(detached)
    const history = await getWorkspaceHistory(detached, { contextId, limit: 5 })
    expect(history.tipOid).toBe(await fixture.git(detached, ['rev-parse', 'HEAD']))
    expect(history.currentRef?.category).toBe('commits')
    expect(history.currentRef?.revision).toBe(history.tipOid)
  })

  it('reports a locally missing object without fetching', async () => {
    const scratch = path.join(fixture.directory, 'missing-object')
    await mkdir(scratch)
    await fixture.git(scratch, ['init', '-q'])
    await fixture.git(scratch, ['checkout', '-b', 'main'])
    await writeFile(path.join(scratch, 'a.txt'), 'a\n')
    await fixture.git(scratch, ['add', '.'])
    await fixture.git(scratch, ['commit', '-qm', 'initial'])
    const lost = await fixture.git(scratch, ['rev-parse', 'HEAD'])
    await writeFile(path.join(scratch, 'b.txt'), 'b\n')
    await fixture.git(scratch, ['add', '.'])
    await fixture.git(scratch, ['commit', '-qm', 'second'])
    const objectPath = path.join(scratch, '.git', 'objects', lost.slice(0, 2), lost.slice(2))
    await unlink(objectPath)

    await expect(getWorkspaceHistory(scratch, { limit: 5 })).rejects.toThrow(
      /not available locally; no fetch was attempted/i
    )
    await expect(getWorkspaceHistory(scratch, { revision: lost })).rejects.toThrow(
      /not available locally; no fetch was attempted/i
    )
    await expect(
      getWorkspaceHistory(scratch, { revision: 'c'.repeat(40) })
    ).rejects.toThrow(/not available locally; no fetch was attempted/i)
  })
})
